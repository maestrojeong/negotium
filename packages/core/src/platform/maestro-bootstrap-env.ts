// The SDK's login-PATH bootstrap is expected host setup, not actionable
// runtime output. Keep it enabled while suppressing its module-load chatter.
process.env.MAESTRO_SDK_SILENT_BOOTSTRAP ??= "1";
