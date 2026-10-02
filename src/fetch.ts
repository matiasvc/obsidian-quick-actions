import { htmlToMarkdown, requestUrl } from "obsidian";

// A model reads at most this much of a page. Longer pages are cut and say so.
const MAX_CHARS = 100_000;

// Page furniture that is never the content. Forms stay, since some sites wrap the whole page in one.
const STRIP = "script, style, noscript, template, svg, canvas, iframe, nav, header, footer, aside, button, dialog, [hidden], [aria-hidden='true']";

export interface FetchedPage {
  markdown: string;
  title: string;
}

// Downloads a page and converts its main content to Markdown with Obsidian's own converter.
export async function fetchPage(url: string): Promise<FetchedPage> {
  const resp = await requestUrl({ url, method: "GET", throw: false, headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" } });
  if (resp.status >= 400) throw new Error(`${new URL(url).host} returned ${resp.status}`);
  const type = (resp.headers["content-type"] ?? resp.headers["Content-Type"] ?? "").toLowerCase();
  if (type.startsWith("text/plain") || type.startsWith("text/markdown")) return { markdown: cap(resp.text), title: "" };
  if (type && !type.includes("html") && !type.includes("xml")) throw new Error(`Not a web page (${type.split(";")[0]})`);

  const doc = new DOMParser().parseFromString(resp.text, "text/html");
  const title = doc.querySelector<HTMLMetaElement>("meta[property='og:title']")?.content?.trim() || doc.title.trim();
  doc.querySelectorAll(STRIP).forEach((el) => el.remove());
  const articles = doc.querySelectorAll("article");
  const main = (articles.length === 1 ? articles[0] : null) ?? doc.querySelector<HTMLElement>("main, [role='main']") ?? doc.body;
  if (!main) throw new Error("The page has no readable text");
  // Links and images keep working once the Markdown is read out of context.
  for (const el of Array.from(main.querySelectorAll<HTMLElement>("a[href], img[src]"))) {
    const attr = el.tagName === "A" ? "href" : "src";
    try {
      el.setAttribute(attr, new URL(el.getAttribute(attr) ?? "", url).href);
    } catch {
      // A malformed URL stays as written.
    }
  }
  const markdown = htmlToMarkdown(main).replace(/\n{3,}/g, "\n\n").trim();
  if (!markdown) throw new Error("The page has no readable text");
  return { markdown: cap(markdown), title };
}

function cap(text: string): string {
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n\n[Page cut here]" : text;
}
