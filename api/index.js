export const config = {
  runtime: 'edge', // run as Edge Function
};

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts.length === 0) {
      return new Response("Usage: /VIDEO_ID or /VIDEO_ID/master.m3u8", {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    const videoId = parts[0];

    if (parts.length > 1 && parts[1] === "seg") {
      const segmentUrl = decodeURIComponent(parts.slice(2).join('/'));
      const headers = getSegmentHeaders();

      if (segmentUrl.endsWith('.m3u8')) {
        const response = await fetchWithRetry(segmentUrl, { headers });
        if (!response.ok) throw new Error(`Failed to fetch playlist: ${response.status}`);

        const playlist = await response.text();
        const baseUrl = new URL(segmentUrl).origin + new URL(segmentUrl).pathname.replace(/[^/]+$/, '');
        const workerBase = `${url.origin}/${videoId}/seg/`;

        const rewrittenPlaylist = playlist.replace(
          /^(?!#)([^\s]+)$/gm,
          (match, u) => {
            try {
              const abs = u.startsWith('http') ? u : new URL(u, baseUrl).href;
              return workerBase + encodeURIComponent(abs);
            } catch {
              return match;
            }
          }
        );

        return new Response(rewrittenPlaylist, {
          headers: getPlaylistHeaders()
        });
      }

      const segResp = await fetchWithRetry(segmentUrl, { headers });
      if (!segResp.ok) throw new Error(`Segment fetch failed: ${segResp.status}`);

      const resHeaders = new Headers(segResp.headers);
      resHeaders.set('Cache-Control', 'public, max-age=3600');
      resHeaders.set('Access-Control-Allow-Origin', '*');

      if (!resHeaders.has('Content-Type')) {
        if (segmentUrl.endsWith('.ts')) resHeaders.set('Content-Type', 'video/MP2T');
        else if (segmentUrl.endsWith('.m4s')) resHeaders.set('Content-Type', 'video/mp4');
      }

      return new Response(segResp.body, { status: segResp.status, headers: resHeaders });
    }

    const ytInfoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const ytPage = await fetchWithRetry(ytInfoUrl, { headers: getYTHeaders() });
    if (!ytPage.ok) throw new Error(`YouTube page fetch failed: ${ytPage.status}`);
    const ytPageText = await ytPage.text();

    let manifestUrl = extractManifestUrl(ytPageText, videoId);
    if (!manifestUrl) {
      return new Response("No stream found. Video might be private, deleted, or not available.", {
        status: 404, headers: { 'Content-Type': 'text/plain' }
      });
    }

    const masterResponse = await fetchWithRetry(manifestUrl, { headers: getMasterHeaders() });
    if (!masterResponse.ok) throw new Error(`Master playlist fetch failed: ${masterResponse.status}`);
    const masterPlaylist = await masterResponse.text();

    const workerBase = `${url.origin}/${videoId}/seg/`;
    const rewrittenPlaylist = masterPlaylist.replace(
      /(https?:\/\/[^\s"]+)/g,
      (match) => workerBase + encodeURIComponent(match)
    );

    return new Response(rewrittenPlaylist, { headers: getPlaylistHeaders() });

  } catch (err) {
    console.error('Error:', err);
    return new Response(`Error: ${err.message}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' }
    });
  }
}

// ===== Helper Functions =====

function getRandomUserAgent() {
  const agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0"
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

function getSegmentHeaders() {
  return {
    "User-Agent": getRandomUserAgent(),
    "Referer": "https://www.youtube.com/",
    "Origin": "https://www.youtube.com",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache"
  };
}

function getYTHeaders() {
  return {
    "User-Agent": getRandomUserAgent(),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
    "Accept-Language": "en-US,en;q=0.9"
  };
}

function getMasterHeaders() {
  return {
    "User-Agent": getRandomUserAgent(),
    "Referer": "https://www.youtube.com/",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9"
  };
}

function getPlaylistHeaders() {
  return {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Access-Control-Allow-Origin': '*'
  };
}

function extractManifestUrl(pageText, videoId) {
  const patterns = [
    /"hlsManifestUrl":"(https:[^"]+\.m3u8)"/,
    /"url":"(https:\/\/[^"]+\/manifest\/hls_[^"]+\/playlist\.m3u8)"/,
    /"hlsManifestUrl":\s*"([^"]+\.m3u8)"/
  ];
  for (const p of patterns) {
    const match = pageText.match(p);
    if (match) return match[1].replace(/\\u0026/g, "&");
  }
  return null;
}

async function fetchWithRetry(url, options, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      if (i > 0) await new Promise(r => setTimeout(r, 1000 * i));
      const res = await fetch(url, options);
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
