// ICE servers for WebRTC. STUN lets two browsers find a direct route; when routers block that (strict NATs,
// school/work Wi-Fi, phone hotspots) the connection has to go through a TURN relay instead.
//
// PeerJS's built-in TURN servers no longer answer, and free credential-less TURN servers are gone, so TURN is
// configured at build time (it ends up in the public JS, so use a free-tier/limited key):
//   VITE_TURN_CREDENTIALS_URL  an endpoint returning an RTCIceServer[] JSON array, e.g. Metered's
//                              https://<app>.metered.live/api/v1/turn/credentials?apiKey=<key>
//   VITE_TURN_SERVERS          or a static RTCIceServer[] JSON array
// Put them in `.env.local` (not committed) before `npm run deploy`.

const STUN: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

let cached: Promise<RTCIceServer[]> | null = null;

/** STUN plus any configured TURN. Never rejects: without TURN, direct connections still work on most networks. */
export function iceServers(): Promise<RTCIceServer[]> {
  cached ??= load();
  return cached;
}

/** `?relay=1` in the URL forces every connection through TURN (for testing the relay from one network). */
export const forceRelay = typeof location !== 'undefined' && new URLSearchParams(location.search).has('relay');

/** Whether a TURN relay is configured (for error messages). */
export const hasTurn = !!(import.meta.env.VITE_TURN_CREDENTIALS_URL || import.meta.env.VITE_TURN_SERVERS);

async function load(): Promise<RTCIceServer[]> {
  const servers = [...STUN];
  try {
    const statics = import.meta.env.VITE_TURN_SERVERS;
    if (statics) servers.push(...(JSON.parse(statics) as RTCIceServer[]));
    const url = import.meta.env.VITE_TURN_CREDENTIALS_URL;
    if (url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) servers.push(...((await res.json()) as RTCIceServer[]));
    }
  } catch (e) {
    console.warn('TURN servers unavailable; only direct connections will work.', e);
  }
  return servers;
}
