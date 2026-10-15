/**
 * WhatsApp, customer-facing (D149). The relay file the deployer uploads to the client's own Cloudflare account must be
 * exactly the one shipped in the package: its sha256 is pinned here and checked before every upload.
 */
export const RELAY_FILE = "relay/whatsapp-relay.mjs";
export const RELAY_SHA256 = "db29195a36e5d28935486bff7a1284d2f789c7e150a4a5afeb27f54111d0d3ff";
