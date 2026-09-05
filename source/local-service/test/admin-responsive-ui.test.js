import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

// These real-browser checks are opt-in: set OLIVIA_BROWSER_UI=1 and expose Playwright through NODE_PATH.
const browserTest = process.env.OLIVIA_BROWSER_UI === "1" ? test : test.skip;
const chromium = process.env.OLIVIA_BROWSER_UI === "1" ? createRequire(import.meta.url)("playwright").chromium : null;
const [html, css, app, updateUI] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/update-download-ui.js", import.meta.url), "utf8"),
]);

const longPath = "I:\\OliviaSoulData\\我的上传\\" + "非常非常长的曲目分类目录\\".repeat(18) + "最终上传曲目.mp4";
const longLetter = "这是用于压力测试的来信内容，没有任何空格，确保记忆卡会测量真实的长正文。".repeat(38);
const fixtureMemory = [{
  letterId: "fixture-letter-1",
  date: "2026-09-04",
  time: "12:00",
  incoming: longLetter,
  reply: longLetter,
  replyLabel: "林离回信",
  replyVideoUrl: null,
  dirty: true,
  summary: "",
  contentMd5: "fixture-memory-md5",
}];
const fixtureMidi = {
  dataRoot: longPath,
  library: { mode: "copy" },
  songs: [{ id: "fixture-song", name: "我的上传曲目：" + "月光".repeat(45), durationUs: 238_000_000 }],
};
const longModelName = `example-local-model-${"very-long-model-segment-".repeat(80)}`;
const fixtureModel = {
  config: {
    activeProvider: "local",
    profiles: {
      deepseek: {
        provider: "deepseek",
        baseUrl: "https://api.example.com/v1",
        model: "example-remote-model",
        authMode: "bearer",
        apiKey: "",
        keyConfigured: false,
      },
      local: {
        provider: "local",
        baseUrl: "http://127.0.0.1:8000/v1",
        model: longModelName,
        authMode: "none",
        apiKey: "",
        keyConfigured: false,
      },
    },
  },
  runtime: { state: "checking", error: null },
};
const viewports = [1366, 1024, 820, 683, 410].map(width => ({ width, height: 760 }));

function appWithFixtureHook() {
  const normalizedApp = app.replace(/\r\n/g, "\n");
  const withoutBootstrap = normalizedApp.replace(
    /\nPromise\.all\(\[refresh\(\), loadDesktopSettings\(\)\]\)\.catch\(showError\);\nsetInterval\(\(\) => refreshStatus\(\)\.catch\(console\.error\), 5000\);\s*$/u,
    "\n",
  );
  assert.notEqual(withoutBootstrap, normalizedApp, "fixture must prevent the real admin bootstrap from calling live services");
  return `${withoutBootstrap}\nwindow.__renderAdminResponsiveFixture = ({ memory, midi, model }) => { memoryExchanges = memory; renderMemoryList(); renderMidiStatus(midi); renderModelConfig(model.config); renderModelRuntime(model.runtime); }; window.__renderAdminModelRuntimeFixture = status => renderModelRuntime(status);`;
}

async function openFixture(t) {
  const browser = await chromium.launch({
    executablePath: process.env.OLIVIA_BROWSER_EXECUTABLE_PATH || undefined,
    headless: process.env.OLIVIA_BROWSER_HEADLESS !== "0",
    timeout: 20_000,
    env: { ...process.env, TEMP: process.env.OLIVIA_BROWSER_TEMP_ROOT, TMP: process.env.OLIVIA_BROWSER_TEMP_ROOT },
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: viewports[0] });
  const markup = html
    .replace(/\s*<script src="\/admin\/song-editor\.js"><\/script>/u, "")
    .replace(/\s*<script type="module" src="\/admin\/app\.js"><\/script>/u, "");
  await page.route("http://admin.fixture/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/admin/styles.css") return route.fulfill({ contentType: "text/css", body: css });
    if (path === "/admin/app-fixture.js") return route.fulfill({ contentType: "text/javascript", body: appWithFixtureHook() });
    if (path === "/admin/update-download-ui.js") return route.fulfill({ contentType: "text/javascript", body: updateUI });
    return route.fulfill({ contentType: "text/html", body: markup });
  });
  await page.goto("http://admin.fixture/admin/", { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ type: "module", url: "http://admin.fixture/admin/app-fixture.js" });
  await page.evaluate(({ memory, midi, model }) => window.__renderAdminResponsiveFixture({ memory, midi, model }), {
    memory: fixtureMemory,
    midi: fixtureMidi,
    model: fixtureModel,
  });
  return page;
}

async function showPage(page, pageName) {
  await page.evaluate(name => {
    document.querySelectorAll(".tabPage").forEach(section => { section.hidden = section.dataset.page !== name; });
    document.querySelector(`.sideTab[data-tab="${name}"]`)?.classList.add("active");
    document.querySelector(".content").scrollTop = 0;
  }, pageName);
}

function assertNoHorizontalOverflow(layout, label) {
  assert.equal(layout.horizontalOverflow, false, `${label} must not have document horizontal overflow`);
  assert.ok(layout.contentRight <= layout.viewportWidth + 1, `${label} content remains inside the viewport`);
}

browserTest("responsive uploads and rendered memory cards keep long fixtures inside every supported viewport", async t => {
  const page = await openFixture(t);
  const screenshots = process.env.OLIVIA_BROWSER_SCREENSHOT_DIR;

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await showPage(page, "performances");
    const uploadLayout = await page.evaluate(() => {
      const container = document.querySelector(".performanceColumns");
      const list = document.querySelector("#midiSongList");
      const path = document.querySelector("#midiDataRoot");
      const tools = document.querySelector(".performanceTools");
      const content = document.querySelector(".content").getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        contentRight: content.right,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        listWidth: list.getBoundingClientRect().width,
        containerWidth: container.getBoundingClientRect().width,
        pathTitle: path.title,
        pathTop: path.getBoundingClientRect().top,
        toolsTop: tools.getBoundingClientRect().top,
        refreshWhiteSpace: getComputedStyle(document.querySelector("#refreshMidiStatus")).whiteSpace,
      };
    });
    assertNoHorizontalOverflow(uploadLayout, `${viewport.width}px uploads`);
    assert.ok(Math.abs(uploadLayout.listWidth - uploadLayout.containerWidth) < 1, `${viewport.width}px uploads use the full list width`);
    assert.equal(uploadLayout.pathTitle, `当前保存目录：${longPath}`, `${viewport.width}px shows the complete data path in a tooltip`);
    assert.ok(uploadLayout.pathTop > uploadLayout.toolsTop, `${viewport.width}px places the long data path on its own line`);
    assert.equal(uploadLayout.refreshWhiteSpace, "nowrap", `${viewport.width}px keeps the refresh button label intact`);
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, `admin-responsive-uploads-${viewport.width}.png`) });
    }

    await showPage(page, "memory");
    const memoryLayout = await page.evaluate(() => {
      const card = document.querySelector(".exchangeCard");
      const body = document.querySelector(".exchangeBody");
      const dateTime = document.querySelector(".exchangeDateTime");
      const actions = document.querySelector(".exchangeActions");
      const content = document.querySelector(".content").getBoundingClientRect();
      const textareas = [...document.querySelectorAll(".exchangeBody textarea")].map(textarea => textarea.getBoundingClientRect());
      return {
        viewportWidth: innerWidth,
        contentRight: content.right,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        cardWidth: card.getBoundingClientRect().width,
        bodyWidth: body.getBoundingClientRect().width,
        dateTimeWidth: dateTime.getBoundingClientRect().width,
        actionsWidth: actions.getBoundingClientRect().width,
        textareas,
      };
    });
    assertNoHorizontalOverflow(memoryLayout, `${viewport.width}px memory`);
    assert.ok(Math.abs(memoryLayout.bodyWidth - (memoryLayout.cardWidth - 30)) < 3, `${viewport.width}px memory body owns the available card width`);
    for (const textarea of memoryLayout.textareas)
      assert.ok(textarea.width > 0 && textarea.right <= memoryLayout.contentRight + 1, `${viewport.width}px memory textarea stays inside its content area`);
    if (screenshots) await page.screenshot({ path: join(screenshots, `admin-responsive-memory-${viewport.width}.png`) });
  }
});

browserTest("long active model status keeps the AI heading and controls inside narrow cards", async t => {
  const page = await openFixture(t);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await showPage(page, "ai");
    const layout = await page.evaluate(() => {
      const header = document.querySelector(".modelSettingsHead");
      const heading = header.firstElementChild;
      const badge = document.querySelector("#activeModelProvider");
      const card = document.querySelector(".currentModelCard");
      const select = document.querySelector("#modelProvider");
      const button = document.querySelector("#activateModelProvider");
      const content = document.querySelector(".content").getBoundingClientRect();
      const rectangles = Object.fromEntries(Object.entries({ header, heading, badge, card, select, button })
        .map(([name, element]) => [name, element.getBoundingClientRect()]));
      const headingChildren = [...heading.children].map(element => element.getBoundingClientRect());
      const headingContent = {
        top: Math.min(...headingChildren.map(rectangle => rectangle.top)),
        bottom: Math.max(...headingChildren.map(rectangle => rectangle.bottom)),
      };
      headingContent.height = headingContent.bottom - headingContent.top;
      return {
        viewportWidth: innerWidth,
        contentRight: content.right,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ...rectangles,
        headingContent,
        badgeTitle: badge.title,
        badgeText: badge.textContent,
        badgeClientWidth: badge.clientWidth,
        badgeScrollWidth: badge.scrollWidth,
        badgeTextOverflow: getComputedStyle(badge).textOverflow,
      };
    });

    assertNoHorizontalOverflow(layout, `${viewport.width}px AI`);
    assert.ok(layout.heading.width >= 160, `${viewport.width}px keeps the AI heading readable`);
    assert.ok(layout.badge.left >= layout.header.left - 1 && layout.badge.right <= layout.header.right + 1,
      `${viewport.width}px keeps the active-model badge inside its header`);
    if (viewport.width <= 620) {
      assert.ok(layout.header.height <= layout.headingContent.height + layout.badge.height + 24,
        `${viewport.width}px keeps the stacked AI header compact`);
      assert.ok(layout.badge.top - layout.headingContent.bottom <= 20,
        `${viewport.width}px leaves no flex-basis gap before the active-model badge`);
    }
    for (const control of [layout.select, layout.button]) {
      assert.ok(control.left >= layout.card.left - 1 && control.right <= layout.card.right + 1,
        `${viewport.width}px keeps provider controls inside the current-model card`);
    }
    assert.equal(layout.badgeTitle, layout.badgeText, `${viewport.width}px exposes the complete active-model status as a tooltip`);
    assert.equal(layout.badgeTextOverflow, "ellipsis", `${viewport.width}px ellipsizes an oversized active-model status`);
    assert.ok(layout.badgeScrollWidth > layout.badgeClientWidth, `${viewport.width}px exercises a genuinely truncated model status`);
    if (viewport.width <= 820)
      assert.ok(layout.button.top > layout.select.bottom, `${viewport.width}px stacks provider controls by card width`);
  }
});

browserTest("active model runtime status replaces its previous value", async t => {
  const page = await openFixture(t);
  const rendered = await page.evaluate(states => {
    for (const state of states) window.__renderAdminModelRuntimeFixture({ state, error: null });
    const badge = document.querySelector("#activeModelProvider");
    return { text: badge.textContent, title: badge.title };
  }, ["checking", "available", "available"]);
  const expected = `当前：本地兼容 API · ${longModelName} · 可用`;
  assert.deepEqual(rendered, { text: expected, title: expected });
});
