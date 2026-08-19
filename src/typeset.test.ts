// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { hasMath } from "./typeset";

/**
 * KaTeX and highlight.js used to load from a CDN on every cold start — ~400 KB
 * of script and stylesheet for cards that mostly contain neither.
 */

describe("deciding a card needs a maths typesetter", () => {
  it("recognises what KaTeX would typeset", () => {
    expect(hasMath("The area is $\\pi r^2$ exactly")).toBe(true);
    expect(hasMath("$$\n\\int_0^1 x\\,dx\n$$")).toBe(true);
    // A bare symbol counts; prose does not put a lone short token in dollars.
    expect(hasMath("where $n$ is the number of shards")).toBe(true);
  });

  it("does not drag in a typesetter for a price", () => {
    // The obvious test — "contains a dollar sign" — fetches 300 KB to render a
    // card about how much something costs.
    expect(hasMath("A t2.micro costs about $8 a month")).toBe(false);
    // KaTeX itself would set "5 to " in Computer Modern here.
    expect(hasMath("Costs $5 to $9 depending on region")).toBe(false);
    expect(hasMath("no dollars here at all")).toBe(false);
  });
});

describe("typesetting a card", () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.head.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    delete (window as any).renderMathInElement;
    delete (window as any).hljs;
  });

  /**
   * Not awaited: jsdom never fires `onload` for a CDN script, so the load
   * promise never settles. What is being asserted is which tags get asked for,
   * and those are appended synchronously.
   */
  async function typesetInto(html: string) {
    vi.resetModules();
    const { typeset } = await import("./typeset");
    container.innerHTML = html;
    void typeset(container);
  }

  it("fetches nothing for a card that is only prose", async () => {
    await typesetInto("<p>Plain text, no maths, no code.</p>");

    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(document.querySelectorAll("link")).toHaveLength(0);
  });

  it("asks for KaTeX only when there is maths, and the highlighter only when there is code", async () => {
    await typesetInto("<p>The area is $\\pi r^2$</p>");
    const afterMath = [...document.querySelectorAll("script")].map((s) =>
      (s as HTMLScriptElement).src
    );
    expect(afterMath.some((src) => src.includes("katex"))).toBe(true);
    expect(afterMath.some((src) => src.includes("highlight"))).toBe(false);

    document.head.innerHTML = "";
    await typesetInto("<pre><code>const x = 1;</code></pre>");
    const afterCode = [...document.querySelectorAll("script")].map((s) =>
      (s as HTMLScriptElement).src
    );
    expect(afterCode.some((src) => src.includes("highlight"))).toBe(true);
    expect(afterCode.some((src) => src.includes("katex"))).toBe(false);
  });

  it("uses a typesetter that is already here rather than waiting on a promise", async () => {
    const renderMathInElement = vi.fn();
    (window as any).renderMathInElement = renderMathInElement;
    vi.resetModules();
    const { typeset } = await import("./typeset");
    container.innerHTML = "<p>The area is $\\pi r^2$</p>";

    typeset(container);

    // Synchronously, in the frame the card was inserted — after the first card
    // of a session this is every card, and a promise would cost a flash of raw
    // TeX on each one.
    expect(renderMathInElement).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("script")).toHaveLength(0);
  });

  it("gives the code themes the ids the theme switcher looks for", async () => {
    await typesetInto("<pre><code>const x = 1;</code></pre>");

    expect(document.getElementById("hljs-light")).not.toBeNull();
    const dark = document.getElementById("hljs-dark") as HTMLLinkElement;
    // Parked on a non-matching query rather than absent, so switching theme is
    // a media change and not another fetch.
    expect(dark.media).toBe("not all");
  });
});
