# Pi Extensions

我的 [Pi 编码助手](https://pi.dev) 扩展集合。

## 扩展列表

| 扩展 | 描述 |
|------|------|
| [notify](extensions/notify.ts) | 任务完成后发送桌面通知（支持 iTerm2、Kitty、Ghostty、WezTerm、Windows Terminal） |

## 安装

### 通过 npm（推荐）

```bash
# 全局安装
pi install npm:@vkzha/pi-extensions

# 或仅当前项目
pi install -l npm:@vkzha/pi-extensions
```

### 通过 GitHub

```bash
pi install git:github.com/<你的用户名>/pi-extensions
```

### 手动使用

也可以直接把扩展文件复制到扩展目录：

```bash
cp extensions/notify.ts ~/.pi/agent/extensions/
```
