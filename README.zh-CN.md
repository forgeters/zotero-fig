# Zotero Fig

[English README](README.md)

<p align="center">
  <img src="addon/content/icons/icon.png" alt="Zotero Fig 图标" width="96" height="96">
</p>

Zotero Fig 是一个适用于 Zotero 7-9 的插件，用于识别 PDF 附件中的图表，
在阅读器侧边栏统一展示，支持精确跳转，并提供图表放大预览。

本项目基于
[windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
开发。

## 快速跳转

- [功能截图](#功能截图)
- [主要功能](#主要功能)
- [环境要求](#环境要求)
- [安装方式](#安装方式)
- [使用方式](#使用方式)
- [开发说明](#开发说明)
- [已知限制](#已知限制)

## 功能截图

### 阅读器侧边栏

![阅读器侧边栏展示识别到的图表](Screenshot/Clip_20260425_155204.png)

### 精确跳转

![从侧边栏跳转到匹配到的图表位置](Screenshot/Clip_20260425_155230.png)

### 图表预览

![支持缩放和拖动的图表放大预览](Screenshot/Clip_20260425_155409.png)

## 主要功能

- 识别 Zotero PDF 阅读器中的 Figure 和 Table 标题
- 在阅读器侧边栏统一展示识别结果
- 从侧边栏跳转到对应图表或表格
- 使用本地 PyMuPDF 解析 PDF，匹配 Figure 对应的 bbox 区域
- 支持两种方式打开图表预览：
  - 在 PDF 阅读器中直接点击图表区域
  - 在侧边栏中右键点击 Figure 条目
- 预览窗口支持滚轮缩放
- 预览窗口支持左键拖动平移
- 点击预览外部空白处或按 `Esc` 可关闭预览

## 环境要求

- Zotero `7.x` / `8.x` / `9.x`
- Python `3.x`
- Zotero Fig 能找到的 Python 环境中已安装 `PyMuPDF`

安装 PyMuPDF：

```powershell
python -m pip install PyMuPDF
```

如果你的系统使用 `py`：

```powershell
py -3 -m pip install PyMuPDF
```

## 安装方式

1. 构建或下载插件的 XPI 安装包
2. 在 Zotero 中打开 `工具 -> 插件`
3. 点击右上角齿轮按钮
4. 选择 `Install Plugin From File...`
5. 选择生成好的 `.xpi` 文件
6. 如有提示，重启 Zotero

构建产物默认位于：

```text
.scaffold/build/zotero-fig.xpi
```

更详细的中文安装说明见：
[doc/user-installation.md](doc/user-installation.md)

## 使用方式

1. 在 Zotero 中打开一个 PDF 附件
2. 打开阅读器右侧的 `图表 / Figures and Tables` 面板
3. 左键点击侧边栏条目，可跳转到对应图表或表格
4. 右键点击侧边栏中的 Figure 条目，可直接打开预览
5. 在 PDF 阅读器中直接点击图表区域，也可打开预览
6. 在预览中：
   - 使用滚轮缩放
   - 使用左键拖动平移
   - 点击外部空白处关闭

补充说明：

- Figure 预览依赖本地 PyMuPDF helper 提供 bbox 匹配结果
- 如果 bbox 不可用，插件会回退到 caption 导航
- Table 当前主要支持 caption 导航，暂不提供单独区域预览

## 开发说明

安装依赖：

```powershell
npm install
```

复制并配置开发环境：

```powershell
Copy-Item .env.example .env
```

然后编辑 `.env`，至少配置：

- `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`
- `ZOTERO_PLUGIN_PROFILE_PATH`

启动热重载开发环境：

```powershell
npm start
```

构建插件：

```powershell
npm run build
```

## 已知限制

- Figure bbox 匹配依赖本地 Python + PyMuPDF helper
- 某些 PDF 仍可能回退到 caption-only 导航
- 当前预览使用阅读器已渲染的 canvas 作为位图来源，因此最终清晰度仍受当前页面渲染分辨率影响
