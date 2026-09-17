// Where the game server lives.
//
// Empty means "this same origin", which is correct when the Node server is
// serving this page — running locally, that is always the case. The static
// build (tools/build-client.mjs) overwrites this file with whatever AAC_SERVER
// is set to, so a client on a CDN knows which host is running the match.
//
// You can also override it per-visit with ?server=wss://your-host on the URL.
window.AAC_SERVER = '';
