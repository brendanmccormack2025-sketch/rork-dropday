// The addresses the post-link rules must accept and refuse: used by BOTH the database test (test-post-links-sql.mjs, link_platform_of) and the app
// test (test-post-links.mjs, parseVideoLink), so the composer and the database cannot drift apart.
export const GOOD = [
  ["https://www.youtube.com/watch?v=abc", "youtube"], ["https://youtube.com/@name", "youtube"], ["https://m.youtube.com/watch?v=1", "youtube"], ["https://music.youtube.com/watch?v=1", "youtube"], ["https://youtu.be/abc", "youtube"],
  ["https://www.tiktok.com/@a/video/1", "tiktok"], ["https://vm.tiktok.com/ZM123/", "tiktok"], ["https://tiktok.com/@a", "tiktok"],
  ["https://www.instagram.com/reel/abc/", "instagram"], ["https://instagram.com/p/abc", "instagram"],
  ["https://x.com/a/status/1", "x"], ["https://www.x.com/a", "x"],
  ["https://www.twitch.tv/videos/1", "twitch"], ["https://twitch.tv/a", "twitch"],
  ["https://open.spotify.com/episode/abc", "spotify"], ["  https://YouTube.com/watch?v=1  ", "youtube"],
];
export const BAD = [
  "https://evil.com/youtube.com", "https://youtube.com.evil.com/x", "https://notyoutube.com/x", "https://youtu.be.evil.com/x", "https://www.youtu.be/x", "https://youtube.com@evil.com/x",
  "http://youtube.com/x", "ftp://youtube.com/x", "javascript:alert(1)", "data:text/html,hi", "https://spotify.com/x", "https://www.spotify.com/x", "https://xx.com/a", "https://notx.com/a",
  "https://twitter.com/a", "https://youtube.com:8080/x", "https://you tube.com/x", "https://youtube.com/a b", "", "   ", "https://", "https://." + "a".repeat(10), "https://youtube.com/" + "a".repeat(500),
];
/** The composer adds https:// to a bare address before sending it; the database then sees the https form. */
export const BARE = [["youtube.com/watch?v=1", "youtube"], ["www.tiktok.com/@a", "tiktok"], ["open.spotify.com/episode/x", "spotify"]];
