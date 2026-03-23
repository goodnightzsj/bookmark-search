import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { resolve } from 'path';

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
    
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_debugger: true,
        pure_funcs: ['console.log']
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
    })
  ]
});
