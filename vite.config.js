import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import obfuscatorPlugin from 'javascript-obfuscator';
import { resolve } from 'path';

// 自定义插件来调用 javascript-obfuscator
function obfuscator(options = {}) {
  return {
    name: 'vite-plugin-obfuscator',
    enforce: 'post', // 在构建后期执行
    transform(code, id) {
      if (/\.js$/.test(id) && !id.includes('node_modules')) {
        const result = obfuscatorPlugin.obfuscate(code, options);
        return {
          code: result.getObfuscatedCode(),
          map: null // 禁用 sourcemap 增加安全性
        };
      }
    }
  };
}

export default defineConfig({
  build: {
    // 输出目录
    outDir: 'dist',
    // 清空输出目录
    emptyOutDir: true,
    // 禁用 CSS 代码分割（将 CSS 提取到单独文件）
    cssCodeSplit: false,
    modulePreload: false,
    
    rollupOptions: {
      // 核心配置：多入口打包
      input: {
        popup: resolve(__dirname, 'popup.html'),
        settings: resolve(__dirname, 'settings.html'),
        background: resolve(__dirname, 'background.js'),
        content: resolve(__dirname, 'content.js'),
      },
      
      output: {
        // 保持文件名不变（去掉 hash），确保 manifest.json 能找到
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      }
    },
    
    // 生产环境移除 console
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true
      }
    }
  },
  
  plugins: [
    // 复制静态资源（manifest, 图标, CSS, 字体等）
    viteStaticCopy({
      targets: [
        { src: 'manifest.json', dest: '.' },
        { src: '*.png', dest: '.' },
        { src: 'themes', dest: '.' }, 
        { src: 'content.css', dest: '.' },
        { src: 'LICENSE', dest: '.' },
        { src: '_locales', dest: '.' }
      ]
    }),
    // 使用自定义混淆插件
    obfuscator({
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.75,
      numbersToExpressions: true,
      simplify: true,
      stringArray: true,
      stringArrayEncoding: 'rc4',
      stringArrayThreshold: 0.75,
      splitStrings: true,
      unicodeEscapeSequence: false,
      renameGlobals: false,
      identifierNamesGenerator: 'hexadecimal',
      // 关键修正：
      target: 'browser-no-eval', // 避免使用 eval，兼容性更好
      selfDefending: false,      // 禁用自我防御（通常依赖 window）
      domainLock: [],            // 禁用域名锁定
      debugProtection: false,    // 禁用调试保护（依赖 debugger 语句）
      disableConsoleOutput: false // 允许 console（可选，方便调试）
    })
  ]
});
