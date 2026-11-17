# 本地部署（这个 fork 怎么装、怎么更新）

这个仓库是 [woniuniuniu/dsh-media-desk](https://github.com/woniuniuniu/dsh-media-desk) 的 fork，
在本地 DSH profile 里用 `file:` 依赖装在 `~/.dsh/profiles/desktop`。

## 装一次

```powershell
# 在 profile 目录里把插件指向本仓库
node <dsh 自带的 pnpm.mjs> add dsh-media-desk@file:C:/Users/<you>/Documents/dsh-media-desk --dir "$env:USERPROFILE\.dsh\profiles\desktop"
```

装完 DSH 里把 `dsh-media-desk` 关掉再打开即可；不需要重启整个 app。

## 改完代码怎么生效

pnpm 的 `file:` 依赖装的是**拷贝**，不是软链，所以改完必须重新同步：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1            # 构建 + 同步 + 校验
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -SkipBuild # client 没改时只同步 host 代码
```

然后在 DSH 里把 `dsh-media-desk` 关掉再打开；如果只改了 `client/`，刷新页面也行。

脚本对「文件被占用」有处理：先写到 `<文件>.new`，再改名覆盖。正在运行的进程继续用旧内容，
所以**不需要先关插件**；但重载插件才会让 host 侧改动生效。

### 常见卡点

| 现象 | 原因 / 处理 |
| --- | --- |
| 直接 `Copy-Item` 覆盖报「文件被占用」 | 插件在跑时 Windows 会锁住已加载的模块。脚本改成「写 `.new` 再改名覆盖」，所以不用先关插件 |
| 改动没生效 | 忘了重载插件（或只改 client 时忘了刷新页面）。脚本最后会打印 md5 校验结果 |
| 插件重载打断正在跑的对话 | 重载会让当前 agent 回合中断，尽量在空闲时做 |

## 目录约定

| 路径 | 作用 |
| --- | --- |
| `src/` | Host 侧：路由、成稿流水线、工作台工具、agent 桥接 |
| `client/` | 浏览器侧源码；`npm run build` 打成 `dist/client.js` |
| `dist/client.js` | 构建产物，**不进 git**（`.gitignore` 里） |
| `docs/` | 设计与踩坑记录 |

## 和工作台数据的关系

插件读写的是 `~/.dsh/media-desk/`：

- `state.json`：条目、成稿、对话（唯一真相）
- `settings.json`：生图/助手模型配置
- `files/`：配图、上传的图片

改插件不会动这些数据；手工改 `state.json` 前记得先备份。
