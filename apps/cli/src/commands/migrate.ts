import { migrateSingleUserState } from "@negotium/core/single-user-migration";

function option(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function migrateCommand(args: string[]): void {
  if (args[0] !== "single-user") {
    throw new Error(
      "usage: negotium migrate single-user [--source=local] --delete-other-users --yes",
    );
  }
  const result = migrateSingleUserState({
    sourcePrincipal: option(args, "source"),
    deleteOtherUsers: args.includes("--delete-other-users"),
    confirmed: args.includes("--yes"),
  });
  console.log(`${result.status}: ${result.markerPath}`);
}
