// The ONE file that imports @plannotator/byoa-protocol. Every other module imports
// "./protocol.ts", so a sync script that copies connector-core and protocol
// into a Claude Code mod (which can import only its own folder) rewrites this
// single line and nothing else. See README, "Copying into a host".
export * from "@plannotator/byoa-protocol";
