// Google Search Console ownership check for https://sermonprocessor.pages.dev/.
// Served by a function so Pages doesn't redirect away the ".html" (a static file
// would be redirected to the address without it, which can fail Google's check).
export const onRequest = () =>
  new Response("google-site-verification: googlec2ca1180891fb537.html", {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
