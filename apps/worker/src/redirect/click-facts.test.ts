import { describe, expect, it } from "vitest";
import { clickFactsOf } from "./click-facts.ts";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";

function visit(headers: Record<string, string>, cf?: { country?: string }): Request {
  const init: RequestInit<IncomingRequestCfProperties> = { headers };
  if (cf) init.cf = cf as IncomingRequestCfProperties;
  return new Request("https://s.example.com/abc123", init);
}

describe("clickFactsOf", () => {
  it("returns exactly the slug, country, referrer host and device class", () => {
    const request = visit(
      {
        "User-Agent": CHROME_MAC,
        Referer: "https://News.Example.ORG/story/42?utm_source=x#top",
        "CF-Connecting-IP": "203.0.113.7",
        "X-Forwarded-For": "203.0.113.7",
        "Accept-Language": "ko-KR",
      },
      { country: "KR" },
    );
    expect(clickFactsOf(request, "abc123")).toStrictEqual({
      slug: "abc123",
      country: "KR",
      referrerHost: "news.example.org",
      deviceClass: "desktop",
    });
  });

  it("uses XX when the country is absent", () => {
    expect(clickFactsOf(visit({}), "s").country).toBe("XX");
    expect(clickFactsOf(visit({}, {}), "s").country).toBe("XX");
  });

  it.each([
    ["no Referer", undefined],
    ["an unparsable Referer", "not a url"],
    ["a Referer with no host", "about:blank"],
    ["an empty Referer", ""],
  ])("uses direct for %s", (_, referer) => {
    const headers: Record<string, string> = referer === undefined ? {} : { Referer: referer };
    expect(clickFactsOf(visit(headers), "s").referrerHost).toBe("direct");
  });

  it.each([
    ["desktop", CHROME_MAC],
    ["desktop", WINDOWS],
    ["desktop", "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"],
    ["mobile", IPHONE],
    ["mobile", ANDROID_PHONE],
    ["tablet", IPAD],
    ["tablet", ANDROID_TABLET],
    ["bot", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
    ["bot", "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"],
    ["bot", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"],
    ["bot", "Twitterbot/1.0"],
    ["bot", "WhatsApp/2.23.20.0"],
    ["bot", "curl/8.7.1"],
    ["bot", "python-requests/2.32.3"],
    ["bot", "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)"],
    ["bot", "Some Web Crawler 1.0"],
    ["bot", "my-spider/0.1"],
    ["unknown", "SomethingElse/1.0"],
    ["unknown", ""],
  ])("classifies the device as %s for %j", (deviceClass, ua) => {
    expect(clickFactsOf(visit({ "User-Agent": ua }), "s").deviceClass).toBe(deviceClass);
  });

  it("classifies a missing User-Agent as unknown", () => {
    expect(clickFactsOf(visit({}), "s").deviceClass).toBe("unknown");
  });
});
