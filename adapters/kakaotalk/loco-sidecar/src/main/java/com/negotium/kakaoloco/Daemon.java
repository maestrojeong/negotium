package com.negotium.kakaoloco;

import com.github.netricecake.kakao.KakaoApi;
import com.github.netricecake.kakao.TalkClient;
import com.github.netricecake.kakao.TalkHandler;
import com.github.netricecake.kakao.exception.*;
import com.github.netricecake.kakao.structs.ChatRoom;
import com.github.netricecake.kakao.structs.Member;
import com.github.netricecake.kakao.structs.Message;
import com.github.netricecake.kakao.structs.MessageType;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * negotium's bridge into {@code com.github.netricecake.kakao} (vendored
 * loco-wrapper, see ../LICENSE.upstream for its original MIT license).
 *
 * This file — and the whole {@code com.negotium.kakaoloco} package — is
 * negotium's own addition; the LOCO protocol implementation itself
 * (everything under {@code com.github.netricecake.kakao}) is left as close
 * to upstream as possible so future protocol patches from upstream (Kakao
 * changes things periodically — see loco-wrapper's own README on the
 * V2SL→TLS migration) stay easy to pull in.
 *
 * Talks newline-delimited JSON over stdio with the TypeScript side
 * (adapters/kakaotalk/src/loco/bridge.ts) — the same pattern
 * negotium already uses for its other local sidecar processes. One JSON
 * object per line, both directions:
 *
 *   stdout (daemon -> negotium):
 *     {"type":"ready","userId":123}
 *     {"type":"needs_registration","passcode":"123456","remainingSeconds":60}
 *     {"type":"message","chatId":..,"roomType":"OM"|"OD"|"MultiChat"|"DirectChat",
 *      "roomName":..,"logId":..,"authorId":..,"authorName":..,"memberType":1|2|4|8,
 *      "text":..,"sendAt":..}
 *     {"type":"member_joined","chatId":..,"userId":..,"nickName":..}
 *     {"type":"member_left","chatId":..,"userId":..,"nickName":..}
 *     {"type":"error","message":".."}
 *     {"type":"disconnected"}
 *     {"type":"send_result","requestId":"..","ok":true|false}
 *
 *   stdin (negotium -> daemon):
 *     {"type":"send","requestId":"..","chatId":..,"text":".."}
 *     {"type":"ping"}
 */
public final class Daemon {

    private static final PrintStream out = System.out;

    private static synchronized void emit(JsonObject obj) {
        out.println(obj.toString());
        out.flush();
    }

    private static JsonObject event(String type) {
        JsonObject o = new JsonObject();
        o.addProperty("type", type);
        return o;
    }

    public static void main(String[] args) throws Exception {
        System.setProperty("jdk.virtualThreadScheduler.parallelism", "1");
        System.setProperty("jdk.virtualThreadScheduler.maxPoolSize", "1");

        String email = requireEnv("NEGOTIUM_KAKAO_LOCO_EMAIL");
        String password = requireEnv("NEGOTIUM_KAKAO_LOCO_PASSWORD");
        String deviceName = System.getenv().getOrDefault("NEGOTIUM_KAKAO_LOCO_DEVICE_NAME", "SM-X930");
        String deviceUuid = requireEnv("NEGOTIUM_KAKAO_LOCO_DEVICE_UUID");

        // TalkClient persists login/session state under cwd/<email>_<deviceName>/ —
        // the TS side sets the working directory to a per-topic state dir it owns
        // (see bridge.ts) rather than this process's own source tree.
        TalkClient client = new TalkClient(email, password, deviceName, deviceUuid, new TalkHandler() {
            @Override
            public void onMessage(Message msg) {
                if (msg.getType() != MessageType.TEXT) return;
                ChatRoom room = msg.getChatRoom();
                Member author = msg.getAuthor();
                JsonObject o = event("message");
                o.addProperty("chatId", room.getChatId());
                o.addProperty("roomType", room.getType());
                o.addProperty("roomName", room.getName());
                o.addProperty("logId", msg.getLogId());
                o.addProperty("authorId", author != null ? author.getUserId() : -1);
                o.addProperty("authorName", author != null ? author.getNickName() : "");
                o.addProperty("memberType", author != null ? author.getMemberType() : 0);
                o.addProperty("text", msg.getMessage());
                o.addProperty("sendAt", msg.getSendTime());
                emit(o);
            }

            @Override
            public void onNewMember(ChatRoom room, Member member) {
                JsonObject o = event("member_joined");
                o.addProperty("chatId", room.getChatId());
                o.addProperty("userId", member.getUserId());
                o.addProperty("nickName", member.getNickName());
                emit(o);
            }

            @Override
            public void onDelMember(ChatRoom room, long userId, String nickName) {
                JsonObject o = event("member_left");
                o.addProperty("chatId", room.getChatId());
                o.addProperty("userId", userId);
                o.addProperty("nickName", nickName);
                emit(o);
            }
        });

        try {
            client.connect();
        } catch (InvalidDeviceNameException e) {
            fail("invalid_device_name", "device name not on Kakao's sub-device allowlist");
            return;
        } catch (InvalidDeviceUUIDException e) {
            fail("invalid_device_uuid", "NEGOTIUM_KAKAO_LOCO_DEVICE_UUID must be a 64-char hex string");
            return;
        } catch (BadCredentialsException e) {
            fail("bad_credentials", "email/phone or password rejected");
            return;
        } catch (BookingFailedException e) {
            fail("booking_failed", "could not reach Kakao's booking server");
            return;
        } catch (LoginFailedException e) {
            fail("login_failed", "session rejected; delete the stored session dir and retry");
            return;
        } catch (UnregisteredDeviceException e) {
            // One-time device approval: a passcode is pushed to the account's
            // ALREADY-TRUSTED device (the operator's real phone). This process
            // blocks (KakaoApi.registerDevice polls internally) until approved
            // or the code expires -- the TS side surfaces the passcode/timeout
            // to the operator and just waits on this same process.
            Map.Entry<String, Integer> passcode = KakaoApi.generatePasscode(email, password, deviceName, deviceUuid);
            JsonObject o = event("needs_registration");
            o.addProperty("passcode", passcode.getKey());
            o.addProperty("remainingSeconds", passcode.getValue());
            emit(o);

            boolean registered = KakaoApi.registerDevice(email, password, deviceUuid);
            if (!registered) {
                fail("registration_failed", "device approval was not completed in time");
                return;
            }
            // Registration succeeded -- recurse into a fresh connect attempt
            // now that the device is trusted (keeps the control flow in one
            // place instead of duplicating the connect() call+catch block).
            main(args);
            return;
        }

        JsonObject ready = event("ready");
        ready.addProperty("userId", client.getMyUserId());
        emit(ready);

        // stdin command loop: one JSON object per line, synchronous replies
        // via stdout "send_result" events correlated by the caller's requestId.
        BufferedReader stdin = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = stdin.readLine()) != null) {
            final String received = line;
            Thread.ofVirtual().start(() -> handleCommand(client, received));
        }

        // stdin closed (parent process exited/killed the pipe) -- nothing left
        // to drive this daemon, so there is no point staying connected.
        emit(event("disconnected"));
        System.exit(0);
    }

    private static void handleCommand(TalkClient client, String line) {
        if (line.isBlank()) return;
        JsonObject cmd;
        try {
            cmd = JsonParser.parseString(line).getAsJsonObject();
        } catch (Exception e) {
            JsonObject o = event("error");
            o.addProperty("message", "malformed command JSON: " + e.getMessage());
            emit(o);
            return;
        }
        String type = cmd.has("type") ? cmd.get("type").getAsString() : "";
        if (type.equals("ping")) return; // liveness probe from the TS side; no reply needed
        if (!type.equals("send")) {
            JsonObject o = event("error");
            o.addProperty("message", "unknown command type: " + type);
            emit(o);
            return;
        }

        String requestId = cmd.has("requestId") ? cmd.get("requestId").getAsString() : "";
        long chatId = cmd.get("chatId").getAsLong();
        String text = cmd.get("text").getAsString();
        boolean ok;
        try {
            ok = client.sendMessage(chatId, text);
        } catch (Exception e) {
            ok = false;
        }
        JsonObject result = event("send_result");
        result.addProperty("requestId", requestId);
        result.addProperty("chatId", chatId);
        result.addProperty("ok", ok);
        emit(result);
    }

    private static void fail(String code, String message) {
        JsonObject o = event("error");
        o.addProperty("code", code);
        o.addProperty("message", message);
        o.addProperty("fatal", true);
        emit(o);
        System.exit(1);
    }

    private static String requireEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            System.err.println("missing required env var: " + name);
            System.exit(2);
        }
        return value;
    }
}
