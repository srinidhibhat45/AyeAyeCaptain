// ============================================================================
//  WHERE THE GAME SERVER LIVES.  This is the one line you edit to go live.
//
//  Paste your server's address between the quotes, keeping the wss:// —
//
//      window.AAC_SERVER = 'wss://aye-aye-captain.onrender.com';
//
//  — then commit and push. Vercel rebuilds from this file, so the push is
//  the deploy. Nothing to set in any dashboard.
//
//  It must be wss://, not ws://. A browser on an https:// page refuses a
//  plaintext socket, and the game will look dead even though the server is
//  perfectly healthy.
//
//  Left empty, the client looks for the match on the same address it was
//  loaded from. That is right when the Node server is serving this page —
//  running locally it always is — and wrong on a static host like Vercel,
//  which cannot run a game server at all.
//
//  For a one-off test you can override it per-visit with ?server=wss://host
//  on the end of the URL, without touching this file.
// ============================================================================
window.AAC_SERVER = '';
