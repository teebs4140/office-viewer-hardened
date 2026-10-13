import { build, context } from 'esbuild'

const isProd = process.argv.indexOf('--mode=production') >= 0;

function createBuildNoticePlugin() {
    return {
        name: 'build notice',
        setup(build) {
            build.onStart(() => {
                console.log('build start')
            })
            build.onEnd(() => {
                console.log('build success')
            })
        }
    };
}

async function runBuild(shouldWatch, options) {
    if (shouldWatch) {
        const ctx = await context(options);
        await ctx.watch();
        return ctx;
    }
    return build(options);
}

function buildDesktopExtension() {
    return runBuild(!isProd, {
        entryPoints: ['./src/extension.ts'],
        bundle: true,
        outfile: "out/extension.js",
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        minify: isProd,
        sourcemap: !isProd,
        logOverride: {
            'duplicate-object-key': "silent",
            'suspicious-boolean-not': "silent",
        },
        plugins: [
            createBuildNoticePlugin(),
        ],
    })
}

(async () => {
    try {
        await buildDesktopExtension();
    } catch {
        process.exit(1);
    }
})();
