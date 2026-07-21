import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { build as esbuild } from "esbuild";

import type { BuildOptions, Plugin } from "esbuild";

const isProduction =
  process.env["NODE_ENV"] === "production" ||
  process.argv.includes("--production");
const writeMetafile = process.argv.includes("--metafile");

const metafilePlugin: Plugin = {
  name: "metafile",
  setup(build) {
    if (writeMetafile && build.initialOptions.outfile) {
      build.initialOptions.metafile = true;
      build.onEnd(async (result) => {
        if (
          !result.errors.length &&
          result.metafile &&
          build.initialOptions.outfile
        ) {
          await mkdir("./dist", { recursive: true });
          const name = basename(build.initialOptions.outfile);
          return writeFile(
            `./dist/${name}.metafile.json`,
            JSON.stringify(result.metafile),
          );
        }
      });
    }
  },
};

const rawLoaderPlugin: Plugin = {
  name: "raw-loader",
  setup(build) {
    const filter = /\?raw$/;
    build.onResolve({ filter }, (args) => {
      let path = args.path.replace("?raw", "");
      path = resolve(args.resolveDir, path);
      return {
        namespace: "raw-loader",
        path,
        sideEffects: false,
      };
    });
    build.onLoad({ filter: /.*/, namespace: "raw-loader" }, async (args) => {
      const contents = await readFile(args.path);
      return {
        contents,
        loader: "text",
      };
    });
  },
};

const scalaLoaderPlugin: Plugin = {
  name: "scala-loader",
  setup(build) {
    const filter = /^#scalajs\/recheck$/;
    build.onResolve({ filter }, (args) => {
      const path = resolve(
        process.cwd(),
        "../../modules/recheck-js/target/scala-3.7.4/recheck-js-opt/recheck.js",
      );
      return {
        external: false,
        path,
        sideEffects: false,
      };
    });
  },
};

type SimpleBuildOptions = Pick<
  BuildOptions,
  | "entryPoints"
  | "inject"
  | "format"
  | "platform"
  | "outfile"
  | "plugins"
  | "bundle"
  | "outdir"
  | "outbase"
>;

async function build(options: SimpleBuildOptions) {
  const buildOptions: BuildOptions = {
    minify: isProduction,
    target: "es2020",
    define: {},
    bundle: true,
    treeShaking: true,
    sourcemap: false && !isProduction,
    logLevel: "error",
    packages: "external",
    ...options,
    plugins: [metafilePlugin, scalaLoaderPlugin].concat(options.plugins ?? []),
  };
  if (buildOptions.format === "cjs") {
    if (buildOptions.outdir) {
      buildOptions.outExtension = { ".js": ".cjs" };
    } else if (buildOptions.outfile) {
      buildOptions.outfile = buildOptions.outfile.replace(/\.js$/, ".cjs");
    }
  }
  // by default esbuild will try `main` package imports before `module`, causing to often bundle dependencies as CJS
  // setting `mainFields` will look for a `module` format (ESM) before `main` (usually CJS)
  // see: https://esbuild.github.io/api/#main-fields
  buildOptions.mainFields = ["module", "main"];
  if (buildOptions.platform === "browser") {
    // if `platform` is browser, have esbuild check for a `browser` format over `module` and `main`
    buildOptions.mainFields.unshift("browser");
  }
  return await esbuild(buildOptions);
}

const main = async () => {
  const formats: BuildOptions["format"][] = ["cjs", "esm"];
  for (const format of formats) {
    const platforms: BuildOptions["platform"][] = ["browser", "node"];
    for (const platform of platforms) {
      // build core for [esm,cjs] with [browser,node]
      await build({
        entryPoints: [
          "src/core/*.ts",
          "src/core/backend/*.ts",
          "src/core/backend/scalajs/index.ts",
          "src/core/backend/synckit/index.ts",
          "src/core/backend/thread-worker/index.ts",
          "src/core/backend/thread-worker/create-worker.ts",
          "src/core/backend/web-worker/index.ts",
          "src/core/backend/web-worker/create-worker.ts",
          "src/core/backend/worker/index.ts",
        ],
        format,
        platform,
        outbase: "src",
        outdir: "lib",
        plugins: [rawLoaderPlugin],
      });
      // build default entry point for [esm,cjs] with [browser,node]
      // NOTE: this is intentionally build with bundle: false, as the entry point will import from core (which is bundled)
      await build({
        bundle: false,
        entryPoints: ["src/index.ts"],
        format,
        platform,
        outfile: "lib/index.js",
        plugins: [rawLoaderPlugin],
      });
    }
    // build browser entry point for [esm,cjs] with [browser]
    // NOTE: this is intentionally build with bundle: false, as the entry point will import from core (which is bundled)
    await build({
      bundle: false,
      entryPoints: ["src/browser.ts"],
      format,
      platform: "browser",
      outfile: "lib/browser.js",
      plugins: [rawLoaderPlugin],
    });
    // build thread.worker.ts for [esm,cjs] with [node]
    await build({
      entryPoints: ["src/core/backend/thread-worker/thread.worker.ts"],
      format,
      platform: "node",
      outfile: "lib/thread.worker.js",
    });
    // build web.worker.ts for [esm,cjs] with [browser]
    await build({
      entryPoints: ["src/core/backend/web-worker/web.worker.ts"],
      format,
      platform: "browser",
      outfile: "lib/web.worker.js",
    });
    // build synckit.worker.ts for [esm,cjs] with [node]
    await build({
      entryPoints: ["src/core/backend/synckit/synckit.worker.ts"],
      format,
      platform: "node",
      outfile: "lib/synckit.worker.js",
    });
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
