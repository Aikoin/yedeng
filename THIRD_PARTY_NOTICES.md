# 第三方说明

本项目使用以下运行时组件；它们不受项目自有代码 MIT 授权替代：

- PDF.js / `pdfjs-dist`：Apache License 2.0。构建脚本从安装包复制 PDF worker、字体、CMap、WASM 和查看器资源，并保留包内 LICENSE 与 NOTICE（如存在）。
- KaTeX：MIT License。构建过程打包其渲染器、样式与字体，另复制其 LICENSE（如存在）。

确切版本由 `pnpm-lock.yaml` 锁定。更多字体和资源的许可说明以各 npm 包随附的声明为准，分发构建产物时应保留这些声明。
