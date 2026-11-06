// X share links for the site. The text is built from facts already on the page and always URL-encoded.
const LIMIT = 280;
// X counts every link as 23 characters, whatever its length.
const LINK = 23;

/** A twitter.com/intent/tweet URL, with the text trimmed so text + link fit in one post. */
export function tweetUrl(text: string, url: string): string {
  const room = LIMIT - LINK - 1;
  const body = text.length > room ? text.slice(0, room - 1).trimEnd() + "…" : text;
  const q = new URLSearchParams({ text: body, url });
  return "https://twitter.com/intent/tweet?" + q.toString();
}

export function setShare(el: HTMLAnchorElement, text: string, url: string) {
  el.href = tweetUrl(text, url);
  el.hidden = false;
}
