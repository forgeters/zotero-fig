# Zotero Fig 用户安装说明

## 适用环境

- Zotero `7.x` / `8.x` / `9.x`
- Windows / macOS / Linux
- 本机可用的 Python `3.x`

## 必需依赖

Zotero Fig 的精确图表定位和图表预览依赖本地 Python helper，因此需要先安装 `PyMuPDF`。

安装命令：

```powershell
python -m pip install PyMuPDF
```

如果你的系统使用 `py`：

```powershell
py -3 -m pip install PyMuPDF
```

安装完成后，可以先检查：

```powershell
python -c "import fitz; print(fitz.__doc__)"
```

或：

```powershell
py -3 -c "import fitz; print(fitz.__doc__)"
```

只要命令没有报错，就说明 PyMuPDF 已经可用。

## 安装插件

如果你已经拿到了构建好的 `.xpi` 文件：

1. 打开 Zotero
2. 进入 `工具 -> 插件`
3. 点击右上角齿轮按钮
4. 选择 `Install Plugin From File...`
5. 选择 `zotero-fig.xpi`
6. 安装后按提示重启 Zotero

如果你是从源码构建：

```powershell
npm install
npm run build
```

生成的安装包位置：

```text
.scaffold/build/zotero-fig.xpi
```

## 使用方式

### 侧边栏识别

1. 在 Zotero 中打开一篇 PDF 附件
2. 打开阅读器右侧的 `图表 / Figures and Tables` 面板
3. 插件会自动扫描文中的 Figure 和 Table

### 跳转

- 左键点击侧边栏条目：跳转到对应图表或表格

### 预览

- 在 PDF 阅读器中，直接点击已识别的图表区域：打开预览
- 在侧边栏中，右键点击 Figure 条目：直接打开该图的预览

预览窗口支持：

- 滚轮缩放
- 左键拖动平移
- 点击外部空白处关闭
- `Esc` 关闭

## 常见情况

### 1. 能识别图表，但预览打不开

先确认：

- Python 已安装
- PyMuPDF 已安装到 Zotero Fig 实际使用的 Python 环境里

可以重新打开 PDF 再试一次。如果是第一次打开文献就直接预览靠后的图表，插件会先跳到对应页并等待渲染，然后再打开预览。

### 2. 只能跳转，不能精确预览

这通常表示：

- 当前 PDF 没有成功匹配到 bbox
- 插件回退到了 caption 导航

这种情况下侧边栏仍然可以跳转，但图像区域预览能力会受限。

### 3. 中文 PDF 识别慢一些

这是正常现象。复杂中文 PDF 的文本层通常更破碎，扫描成本会更高。

## 当前功能范围

已完成：

- 图表侧边栏
- Figure / Table 文本识别
- 中英文 caption 兼容
- 精确 bbox 跳转
- 图表预览

当前限制：

- Table 目前以 caption 导航为主，没有单独区域预览
- 预览清晰度受当前 reader 渲染分辨率影响
