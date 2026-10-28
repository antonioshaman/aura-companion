// AC3.3 grader (PLAN Task 13). CI runs only this: the deterministic grader on
// synthetic answers, and a replay of the stored live transcripts (each must
// re-grade to the verdict it was stored with). The live model run itself
// (evals/uiux-platform-runner.ts) is deliberately outside CI.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { grade, loadFixtures, summarise, TRANSCRIPTS_DIR, type Transcript } from "./grade.js";

const fx = Object.fromEntries(loadFixtures().map((f) => [f.id, f]));

const TMA_GOOD = `
const tg = window.Telegram.WebApp;
tg.BackButton.show(); tg.BackButton.onClick(() => navigate("/cart"));
tg.MainButton.setText("Pay"); tg.MainButton.show();
.screen { background: var(--tg-theme-bg-color); padding-top: var(--tg-content-safe-area-inset-top);
  height: var(--tg-viewport-stable-height, 100vh); }
.row { min-height: 44px; }
`;

const NATIVE_GOOD = `
<SafeAreaView style={{ flex: 1 }}>
  <Text allowFontScaling maxFontSizeMultiplier={2}>Account</Text>
  <Pressable style={{ minHeight: 48 }} onPress={() => Alert.alert("Delete account?", "", [{ text: "Cancel" }, { text: "Delete", style: "destructive" }])} />
</SafeAreaView>
`;

describe("grade — platform fixtures need every marker and no web-only anti-marker", () => {
  it("a Mini App answer using the host controls, theme, safe areas and 44 px targets passes", () => {
    const g = grade(TMA_GOOD, fx["tma-checkout"]);
    expect(g.markers).toEqual({ "safe-area": true, "back-button": true, "main-button": true, "theme-params": true, "touch-target-44-48": true });
    expect(g.pass).toBe(true);
  });

  it("100vh as the fallback inside the Telegram viewport variable is not the web-only anti-marker", () => {
    expect(grade(TMA_GOOD, fx["tma-checkout"]).antiMarkers["bare-100vh"]).toBe(false);
    expect(grade(`${TMA_GOOD}\n.page { height: 100vh; }`, fx["tma-checkout"]).antiMarkers["bare-100vh"]).toBe(true);
  });

  it("prose that rejects 100vh is not a use of it (false positive seen in the 2026-10-28 live run)", () => {
    // Two live answers explained "uses --tg-viewport-stable-height instead of `100vh`" in prose
    // while their CSS used the Telegram variable with a 100vh fallback; only CSS use is the defect.
    expect(grade(`${TMA_GOOD}\nThe height uses the stable viewport variable instead of \`100vh\`.`, fx["tma-checkout"]).antiMarkers["bare-100vh"]).toBe(false);
    expect(grade(`${TMA_GOOD}\n.page { min-height: 100vh; }`, fx["tma-checkout"]).antiMarkers["bare-100vh"]).toBe(true);
  });

  it("an answer with an in-page back and no BackButton fails on the missing marker", () => {
    const g = grade(TMA_GOOD.replace(/BackButton/g, "history"), fx["tma-checkout"]);
    expect(g.markers["back-button"]).toBe(false);
    expect(g.pass).toBe(false);
  });

  it("window.confirm in a Mini App fails even when every marker hits", () => {
    const g = grade(`${TMA_GOOD}\nif (!window.confirm("Pay?")) return;`, fx["tma-checkout"]);
    expect(g.antiMarkers["browser-confirm"]).toBe(true);
    expect(g.pass).toBe(false);
  });

  it("a 32 px target does not count as a 44/48 target", () => {
    expect(grade(TMA_GOOD.replace("min-height: 44px", "min-height: 32px"), fx["tma-checkout"]).markers["touch-target-44-48"]).toBe(false);
  });

  it("a React Native answer with safe areas, font scaling, 48 targets and a native confirm passes", () => {
    expect(grade(NATIVE_GOOD, fx["native-settings"]).pass).toBe(true);
    expect(grade(NATIVE_GOOD.replace(/allowFontScaling maxFontSizeMultiplier=\{2\}/, ""), fx["native-settings"]).markers["dynamic-type"]).toBe(false);
  });
});

describe("grade — the paired web control must NOT produce platform markers", () => {
  it("a plain web checkout passes", () => {
    expect(grade(`<button onClick={() => history.back()}>Back</button>\n.pay { min-height: 44px; }`, fx["web-checkout"]).pass).toBe(true);
  });

  it("Telegram or native APIs leaking into a web page fail the control", () => {
    expect(grade("const tg = Telegram.WebApp; tg.MainButton.show();", fx["web-checkout"]).pass).toBe(false);
    expect(grade("<SafeAreaView>", fx["web-checkout"]).antiMarkers["native-api-leak"]).toBe(true);
  });
});

describe("fixtures cover every platform with a control", () => {
  it("one Mini App fixture, one native (iOS + Android) fixture, one paired web control", () => {
    expect(Object.values(fx).map((f) => `${f.id}:${f.kind}`).sort()).toEqual(["native-settings:platform", "tma-checkout:platform", "web-checkout:web-control"]);
    // The control differs from the Mini App task only in the target it names.
    expect(fx["web-checkout"].prompt.replace("checkout page of our web shop", "X")).toBe(fx["tma-checkout"].prompt.replace("checkout screen of our Telegram Mini App", "X"));
  });
});

describe("replay — every stored live transcript re-grades to its stored verdict", () => {
  const files = readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith(".json"));
  const ts = files.map((f) => JSON.parse(readFileSync(join(TRANSCRIPTS_DIR, f), "utf8")) as Transcript);

  it("there is a stored run for every fixture in both arms", () => {
    const have = new Set(ts.map((t) => `${t.fixture}:${t.arm}`));
    for (const id of Object.keys(fx)) for (const arm of ["with", "without"]) expect(have.has(`${id}:${arm}`), `${id}:${arm}`).toBe(true);
  });

  it.each(files)("%s", (f) => {
    const t = ts[files.indexOf(f)];
    expect(grade(t.output, fx[t.fixture])).toEqual(t.grade);
  });

  it("summarise counts passes per fixture and arm", () => {
    const s = summarise(ts);
    expect(s.reduce((n, r) => n + r.runs, 0)).toBe(ts.length);
  });
});
