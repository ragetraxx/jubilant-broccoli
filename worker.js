export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split('/').filter(Boolean);
 
      if (parts.length === 0) {
        return new Response("Usage: /VIDEO_ID or /VIDEO_ID/master.m3u8", {
          status: 400,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
 
      const videoId = parts[0];
      const isMasterRequest = parts[1] === 'master.m3u8';
 
      // Handle segment requests
      if (parts.length > 1 && parts[1] === "seg") {
        const segmentUrl = decodeURIComponent(parts.slice(2).join('/'));
        const headers = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.youtube.com/",
          "Origin": "https://www.youtube.com",
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "cross-site"
        };
   
        // Handle playlist files (m3u8)
        if (segmentUrl.endsWith('.m3u8')) {
          const response = await fetchWithRetry(segmentUrl, { headers });
          if (!response.ok) throw new Error(`Failed to fetch playlist: ${response.status}`);
     
          const playlist = await response.text();
          const baseUrl = new URL(segmentUrl).origin + new URL(segmentUrl).pathname.replace(/[^/]+$/, '');
          const workerBase = `${url.origin}/${videoId}/seg/`;
     
          // Rewrite all URLs in the playlist
          const rewrittenPlaylist = playlist.replace(
            /^(?!#)([^\s]+)$/gm,
            (match, url) => {
              if (!url.trim()) return match;
              try {
                const absoluteUrl = url.startsWith('http') ? url : new URL(url, baseUrl).href;
                return workerBase + encodeURIComponent(absoluteUrl);
              } catch (e) {
                return match;
              }
            }
          );
     
          return new Response(rewrittenPlaylist, {
            headers: {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Pragma': 'no-cache',
              'Expires': '0',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
              'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept'
            }
          });
        }
   
        // Handle video segments (ts, m4s, etc.)
        const segmentResponse = await fetchWithRetry(segmentUrl, { headers });
        if (!segmentResponse.ok) throw new Error(`Segment fetch failed: ${segmentResponse.status}`);
   
        // Copy headers from original response
        const responseHeaders = new Headers(segmentResponse.headers);
        responseHeaders.set('Cache-Control', 'public, max-age=3600');
        responseHeaders.set('Access-Control-Allow-Origin', '*');
   
        // Only set content type if not already present
        if (!responseHeaders.has('Content-Type')) {
          if (segmentUrl.endsWith('.ts')) {
            responseHeaders.set('Content-Type', 'video/MP2T');
          } else if (segmentUrl.endsWith('.m4s')) {
            responseHeaders.set('Content-Type', 'video/mp4');
          }
        }
   
        return new Response(segmentResponse.body, {
          status: segmentResponse.status,
          headers: responseHeaders
        });
      }
 
      // Get YouTube page data with improved headers
      const ytInfoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const ytPage = await fetchWithRetry(ytInfoUrl, {
        headers: {
          "User-Agent": getRandomUserAgent(),
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Upgrade-Insecure-Requests": "1"
        }
      });
 
      if (!ytPage.ok) throw new Error(`YouTube page fetch failed: ${ytPage.status}`);
      const ytPageText = await ytPage.text();
 
      // Extract HLS manifest URL with enhanced patterns
      let manifestUrl = null;
      const patterns = [
        /"hlsManifestUrl":"(https:[^"]+\.m3u8)"/,
        /"url":"(https:\/\/[^"]+\/manifest\/hls_[^"]+\/playlist\.m3u8)"/,
        /"hlsManifestUrl":\s*"([^"]+\.m3u8)"/,
        /"streamingData":\s*{.*?"hlsManifestUrl":\s*"(https:[^"]+\.m3u8)"/
      ];
 
      for (const pattern of patterns) {
        const match = ytPageText.match(pattern);
        if (match) {
          manifestUrl = match[1].replace(/\\u0026/g, "&");
          break;
        }
      }
 
      // Fallback to ytInitialPlayerResponse
      if (!manifestUrl) {
        const playerResponseMatch = ytPageText.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/);
        if (playerResponseMatch) {
          try {
            const playerData = JSON.parse(playerResponseMatch[1]);
            if (playerData.streamingData && playerData.streamingData.hlsManifestUrl) {
              manifestUrl = playerData.streamingData.hlsManifestUrl;
            }
          } catch (e) {
            console.error("Failed to parse player response", e);
          }
        }
      }
 
      // Fallback for live streams
      if (!manifestUrl) {
        const liveMatch = ytPageText.match(/"videoId":"(\w+)".+?"isLive":true/);
        if (liveMatch && liveMatch[1] === videoId) {
          return new Response("Livestream detected but no HLS manifest available. Try again later.", {
            status: 404,
            headers: { 'Content-Type': 'text/plain' }
          });
        }
      }
 
      if (!manifestUrl) {
        return new Response("No stream found. Video might be private, deleted, or not available.", {
          status: 404,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
 
      // Fetch the master playlist with optimized headers
      const masterResponse = await fetchWithRetry(manifestUrl, {
        headers: {
          "User-Agent": getRandomUserAgent(),
          "Referer": "https://www.youtube.com/",
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "cross-site"
        }
      });
 
      if (!masterResponse.ok) throw new Error(`Master playlist fetch failed: ${masterResponse.status}`);
      const masterPlaylist = await masterResponse.text();
 
      // Rewrite the master playlist
      const workerBase = `${url.origin}/${videoId}/seg/`;
      const rewrittenPlaylist = masterPlaylist.replace(
        /(https?:\/\/[^\s"]+)/g,
        (match) => workerBase + encodeURIComponent(match)
      );
 
      return new Response(rewrittenPlaylist, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
          'X-Content-Type-Options': 'nosniff'
        }
      });
 
    } catch (err) {
      console.error('Worker error:', err);
      return new Response(`Error: ${err.message}`, {
        status: 500,
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-cache'
        }
      });
    }
  }
};

// Helper function for random User-Agent rotation
function getRandomUserAgent() {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0"
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Helper function for retry logic
async function fetchWithRetry(url, options, retries = 3) {
  let lastError;
 
  for (let i = 0; i < retries; i++) {
    try {
      // Add delay between retries
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
 
      const response = await fetch(url, options);
 
      // Retry on 429 (Too Many Requests) or 5xx errors
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        lastError = new Error(`Server responded with ${response.status}`);
        continue;
      }
 
      return response;
    } catch (err) {
      lastError = err;
      if (i === retries - 1) break;
    }
  }
 
  throw lastError || new Error('Max retries exceeded');
          }
