// GENERATED from packages/connector-core/src/index.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// @plannotator/byoa-connector-core: the host-free core of the BYOA connector. A host
// adapter builds one Connector, attaches its interactive sessions, calls
// `tick()` about every second, binds `/byoa` to `command()`, and feeds its
// host's turn events into each SessionHandle. See README.md.
export { Connector, SHARING_EVERY_MS, type ConnectorDeps } from "./connector.ts";
export type { Display, HostAdapter, HostSession, ProxiedTool, SessionHandle } from "./host.ts";
export type { Clock, FilePort, HttpPort, HttpRequest, HttpResponse } from "./ports.ts";
export { COMMAND } from "./status.ts";
export { turnText, matchesTurn, isSlashCommand } from "./turn-text.ts";
export { credentialPath, credentialsDir } from "./credentials.ts";
export { DEFAULT_SHARE, policyPath } from "./sharing.ts";
export { MAX_HELD, START_TIMEOUT_MS } from "./turns.ts";
export { CONNECTOR_NAME, CONNECTOR_VERSION } from "./version.ts";
