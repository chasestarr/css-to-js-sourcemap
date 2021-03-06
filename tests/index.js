/* eslint-env node */
/* global window */

const fs = require("fs");
const {URL} = require("url");

const isCI = require("is-ci");
const createServer = require("css-to-js-sourcemap-fixture-app");
const puppeteer = require("puppeteer");
const getPort = require("get-port");
const test = require("tape");

const {getConsumer} = require("./mapper.js");

const fixtures = {
  clientSource: fs.readFileSync(
    require.resolve("css-to-js-sourcemap-fixture-app/client.js"),
    "utf-8",
  ),
  clientNoMapRaw: fs.readFileSync(
    require.resolve("css-to-js-sourcemap-fixture-app/public/_static/no-map.js"),
    "utf-8",
  ),
  clientExternalMapRaw: fs.readFileSync(
    require.resolve(
      "css-to-js-sourcemap-fixture-app/public/_static/external-map.js",
    ),
    "utf-8",
  ),
};

testSingleMap("/external-map");
testSingleMap("/inline-map");

test(`single mapped class works on /no-map`, async t => {
  const {page, browser, server} = await setup(
    "/no-map",
    async msg => {
      if (msg.css) {
        const lines = msg.css.split("\n");
        t.equal(lines[0], ".__debug-1 {}", "has expected class on line 1");
        const consumer = await getConsumer(msg.css);
        const pos = consumer.originalPositionFor({line: 1, column: 0});

        const lineNumber =
          fixtures.clientNoMapRaw
            .split("\n")
            .indexOf(`const err1 = new Error("Line 5");`) + 1;

        t.equal(pos.line, lineNumber, "mapped line number matches expected");
        t.equal(pos.column, 0, "mapped column matches expected");
        const {hostname, pathname, protocol} = new URL(pos.source);
        t.equal(hostname, "localhost");
        t.equal(pathname, "/_static/no-map.js");
        t.equal(protocol, "http:");
        const content = consumer.sourceContentFor(pos.source);
        t.equal(
          content,
          fixtures.clientNoMapRaw,
          "mapped source content matches expected",
        );
        await browser.close();
        server.close();
        t.end();
      }
    },
    () => {
      t.fail("recieved error");
    },
  );
  page.evaluate(() => {
    window.worker.postMessage({
      id: "init_wasm",
      url: "/mappings.wasm",
    });
    window.worker.postMessage({
      id: "add_mapped_class",
      stackInfo: window.error1,
      className: "__debug-1",
      stackIndex: 0,
    });
    window.worker.postMessage({
      id: "set_render_interval",
      interval: 60,
    });
  });
});

test(`replaying requests after invalidation`, async t => {
  const {page, browser, server} = await setup(
    "/external-map",
    async msg => {
      if (msg.css) {
        const lines = msg.css.split("\n");
        t.equal(lines[0], ".__debug-1 {}", "has expected class on line 1");
        const consumer = await getConsumer(msg.css);
        const pos = consumer.originalPositionFor({line: 1, column: 0});
        t.equal(pos.line, 7, "mapped line number matches expected");
        t.equal(pos.column, 0, "mapped column matches expected");
        t.equal(
          pos.source,
          "webpack:///client.js?n=1",
          "mapped source matches expected",
        );
        const content = consumer.sourceContentFor("webpack:///client.js?n=1");
        t.equal(
          content,
          fixtures.clientSource,
          "mapped source content matches expected",
        );
        await browser.close();
        server.close();
        t.end();
      }
    },
    () => {
      t.fail("recieved error");
    },
  );
  await page.setRequestInterception(true);
  let invalidated = false;
  page.on("request", req => {
    req.continue();
    if (req._url.endsWith(".js.map")) {
      // invalidate after first request
      if (!invalidated) {
        page.evaluate(() => {
          window.worker.postMessage({
            id: "invalidate",
          });
        });
        invalidated = true;
      } else {
        t.pass("sourcemap fetched twice");
        // end test
        page.evaluate(() => {
          window.worker.postMessage({
            id: "set_render_interval",
            interval: 60,
          });
        });
      }
    }
  });
  await page.evaluate(() => {
    window.worker.postMessage({
      id: "init_wasm",
      url: "/mappings.wasm",
    });
    window.worker.postMessage({
      id: "add_mapped_class",
      stackInfo: window.error1,
      className: "__debug-1",
      stackIndex: 0,
    });
  });
});

test(`fallback if sourcemap request is 404`, async t => {
  const {page, browser, server} = await setup(
    "/external-map",
    async msg => {
      if (msg.css) {
        const lines = msg.css.split("\n");
        t.equal(lines[0], ".__debug-1 {}", "has expected class on line 1");
        const consumer = await getConsumer(msg.css);
        const pos = consumer.originalPositionFor({line: 1, column: 0});

        const lineNumber =
          fixtures.clientExternalMapRaw
            .split("\n")
            .indexOf(`const err1 = new Error("Line 5");`) + 1;

        t.equal(pos.line, lineNumber, "mapped line number matches expected");
        t.equal(pos.column, 0, "mapped column matches expected");
        const {hostname, pathname, protocol} = new URL(pos.source);
        t.equal(hostname, "localhost");
        t.equal(pathname, "/_static/external-map.js");
        t.equal(protocol, "http:");
        const content = consumer.sourceContentFor(pos.source);
        t.equal(
          content,
          fixtures.clientExternalMapRaw,
          "mapped source content matches expected",
        );
        await browser.close();
        server.close();
        t.end();
      }
    },
    () => {
      t.fail("recieved error");
    },
  );
  await page.setRequestInterception(true);
  page.on("request", req => {
    if (req._url.endsWith(".js.map")) {
      req.respond({
        status: 404,
      });
    } else {
      req.continue();
    }
  });
  await page.evaluate(() => {
    window.worker.postMessage({
      id: "init_wasm",
      url: "/mappings.wasm",
    });
    window.worker.postMessage({
      id: "add_mapped_class",
      stackInfo: window.error1,
      className: "__debug-1",
      stackIndex: 0,
    });
    window.worker.postMessage({
      id: "set_render_interval",
      interval: 60,
    });
  });
});

function testSingleMap(route) {
  test(`single mapped class works on ${route}`, async t => {
    const {page, browser, server} = await setup(
      route,
      async msg => {
        if (msg.css) {
          const lines = msg.css.split("\n");
          t.equal(lines[0], ".__debug-1 {}", "has expected class on line 1");
          const consumer = await getConsumer(msg.css);
          const pos = consumer.originalPositionFor({line: 1, column: 0});
          t.equal(pos.line, 7, "mapped line number matches expected");
          t.equal(pos.column, 0, "mapped column matches expected");
          t.equal(
            pos.source,
            "webpack:///client.js?n=0",
            "mapped source matches expected",
          );
          const content = consumer.sourceContentFor("webpack:///client.js?n=0");
          t.equal(
            content,
            fixtures.clientSource,
            "mapped source content matches expected",
          );
          await browser.close();
          server.close();
          t.end();
        }
      },
      () => {
        t.fail("Recieved error");
      },
    );
    page.evaluate(() => {
      window.worker.postMessage({
        id: "init_wasm",
        url: "/mappings.wasm",
      });
      window.worker.postMessage({
        id: "add_mapped_class",
        stackInfo: window.error1,
        className: "__debug-1",
        stackIndex: 0,
      });
      window.worker.postMessage({
        id: "set_render_interval",
        interval: 60,
      });
    });
  });
}

function startServer() {
  const server = createServer();
  return new Promise(resolve => {
    getPort(49348).then(port => {
      server.listen(port, () => resolve({port, server}));
    });
  });
}

async function setup(route, msgHandler, errHandler) {
  const {port, server} = await startServer();
  const browser = await puppeteer.launch(
    isCI ? {args: ["--no-sandbox", "--disable-dev-shm-usage"]} : {},
  );
  const page = await browser.newPage();
  let url = `http://localhost:${port}${route}`;
  await page.goto(url);
  page.on("console", msg => {
    Promise.all(msg.args().map(a => a.jsonValue())).then(async args => {
      if (args[0] === "__on_message__") {
        msgHandler(args[1]);
      } else if (args[0] === "Debug worker error") {
        errHandler(args[1]);
      }
    });
  });
  await page.evaluate(() => {
    window.worker.onmessage = msg => {
      /* eslint-disable-next-line no-console */
      console.log("__on_message__", msg.data);
    };
  });
  return {page, browser, server};
}
