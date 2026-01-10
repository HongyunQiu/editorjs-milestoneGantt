里程碑甘特图工具

该工具是针对editorjs-milestone block工具生成的数据，实现对QNotes数据库中所有的milestone数据的分析，从而生成甘特图。

editorjs-milestone block的数据主要包含：内容，项目，人员（可以多个），开始时间和结束时间。这些要素对于生成甘特图而言，是完备的。

本项目需要生成一个基于editor.js的里程碑甘特图工具。需要注意该工具对QNotes的数据库里面的milestone block块搜索的权限问题。该权限范围取决于编辑者自身的权限。因此，需要获得插入这个块用户名。以便基于该用户在QNotes所在的群组权限，决定里程碑甘特图的搜索范围。

同时，还需要实现两种不同统计方法的甘特图，一种是以项目粗纵坐标，内容为细纵坐标。一种是以人员为纵坐标，内容为细纵坐标。

横坐标均为时间，最小单位是天。

参考工程位于
/PlugIns/editorjs-milestone

---

## 本次实现总结（已验证可用）

### 1. 模块化方向：仅使用通用块查询接口

为保持插件模块化，本工具**不新增专用后端接口**，统一复用 QNotes 的标准接口：

- `GET /api/editor/blocks/query`

并在该接口上补充了通用能力，以支持“按插入者（creator）权限上下文”进行查询：

- **分页**：新增 `offset` 参数（配合原有 `limit`）
- **上下文权限**：新增 `context_note_id` + `context_block_index`
  - 服务端会从该 note 的指定 block 的 `block.data.creator.id` 读取“有效用户”，并以该用户作为可见性计算依据，决定遍历的 notes 范围
  - 同时会先校验当前登录用户是否有权访问 `context_note_id`（避免越权构造上下文）

该设计参考了 `warehouse` 的模式（见 `QNotes/doc/全局搜索功能说明_v1.md`），保证其它插件也可复用这套机制。

### 2. 安全：creator 防篡改（服务端强约束）

在保存笔记 `PUT /api/notes/:id` 时对 `milestoneGantt` 的 `data.creator` 做服务端校验：

- 若 `creator` 缺失：写入当前保存用户（用于后续按 creator 权限查询）
- 若 `creator.id` 与当前保存用户不一致：拒绝保存（避免“转移权限归属/冒用权限”）

### 3. 插件功能：两种视图 + 日粒度横轴

工具块 `milestoneGantt` 支持：

- **按项目视图**：纵轴=项目（粗）+ 节点内容（细）
- **按人员视图**：纵轴=人员（粗）+ 节点内容（细）
- **横轴**：时间（日粒度）
- 通过 `queryBlocks(type='milestone')` 拉取数据并在块内自绘 SVG 甘特图

### 4. QNotes 前端接入

已完成：

- `public/index.html` 增加 vendor 引入：`vendor/editorjs-milestoneGantt/milestoneGantt.umd.js`
- `public/app.js` 在 `setupEditor()` 中注册 `milestoneGantt` tool，并注入：
  - `getCurrentUser()`：首次写入 creator
  - `getCurrentNoteId()` / `getCurrentBlockIndex()`：提供上下文
  - `queryBlocks()`：调用 `/api/editor/blocks/query`（携带 `offset/context_*`）
- `public/admin.js` 增加工具显示名（管理后台群组工具权限矩阵）

### 5. 后端工具权限 key

`QNotes/src/server.js` 的 `ALL_EDITOR_TOOL_KEYS` 已加入：

- `milestoneGantt`

以确保：

- 群组工具权限可配置
- 保存时的“工具类型白名单”校验可通过

---

## 构建与发布

在插件目录执行：

- 安装依赖：`npm install`
- 构建：`npm run build`
- 复制产物到 QNotes：运行 `build_dist_copy.bat`
  - 会把 `dist/milestoneGantt.umd.js` 复制到 `QNotes/public/vendor/editorjs-milestoneGantt/milestoneGantt.umd.js`
