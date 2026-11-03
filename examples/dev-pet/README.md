# dev-pet · 开发自测宠物包

> **这不是正式美术素材**，是一份**能跑、能切帧、能点、体积小**的自测用宠物包，给客户端开发（交互 / 数值 / 提醒 / 专注）与 CI 当 fixture 用。
> 正式素材请按 [05-素材管线](../../docs/05-素材管线.md) 自生成——AI 抽帧、抠图、拼表一条龙。

## 为什么需要它

1. 仓库里的 `redshao-demo` 只有 3 个动作（idle 抱熊 / sleep / stretch），**没有 `wiggle`**——而提醒到点要播的就是 `wiggle`，没法测"提醒三件套"。
2. `dingdang-demo` 只有 2 个动作，且单帧 655px、两张共 7.9MB，加载慢。
3. 作者那只完整 8 动作的宠物包不在仓库里（素材版权归宠物主人）。

所以这里提供一个 **8 动作齐全、0.5MB 以内、256px 小格子** 的包，用于：

| 自测点 | 怎么用 |
|---|---|
| 8 动作菜单 / 随机切换 / 转移链 | `sleep → stretch(80) → idle(20)` 一条真实链 |
| 提醒到点播 `wiggle` | 有 `wiggle` 动作 |
| 专注态（休息） | 有 `sleep` |
| **透明区不响应点击**（alpha 命中检测） | 每帧透明占比 52%–89%，四周留白充足 |
| 胶囊头像 | 取 `idle` 首帧（方形，CSS 圆裁即可） |
| 人格气泡 | `persona: "温柔"`，缺省回退 `bubbles` |
| 气质调制 | `temperament` 全 0.5（中性，不改变随机权重） |

## 素材来源（重要）

- **真实素材**：`idle`（叮当叼鳄鱼打盹）、`belly`（叮当躺下作揖）——取自 [../dingdang-demo](../dingdang-demo)。
- **派生占位**：`sleep` / `stretch` / `sniff` / `wiggle` / `run` / `poop` 由 `idle` 帧做几何变换（旋转 / 平移 / 纵向压扁 / 拉伸）得到，**帧间差异明确但姿势不真实**。
- **为什么只用叮当**：红苕的 `knead` 精灵表是**不透明 RGB**（透明占比 0%），用它做底会让"透明区不响应点击"这条自测失效；红苕的 `sleep`/`stretch` 虽是 RGBA，但混两只狗会让 idle→sleep 的观感跳变，掩盖问题。

## 规格

| 项 | 值 |
|---|---|
| 包 id | `dev-pet`（= 目录名） |
| 动作 | 8 个：`idle` `sleep` `stretch` `sniff` `wiggle` `run` `belly` `poop` |
| 帧 | 每动作 8 帧，`fps: 5`，单帧 `256×256` |
| 精灵表 | `2048×256` WebP（RGBA），单表 44–84KB |
| 包体积 | **≈0.5MB**（CONTRIBUTING 上限：单表 ≤2MB、单包 ≤10MB） |
| 契约 | `version: 3`；含 `bubbles` / `persona` / `temperament` / `label` / `diary` / `transitions` |

## 用法

```bash
# 复制到用户数据目录即可（macOS / Windows 同一条命令，路径按系统替换）
cp -r examples/dev-pet ~/.petpet/pets/dev-pet
# Windows：
# xcopy /E /I examples\dev-pet %USERPROFILE%\.petpet\pets\dev-pet

# 校验
python pipeline/validate_pet.py examples/dev-pet
```

托盘菜单「🐕 切换宠物」或右键动作菜单里选它即可。

## 重新生成

素材或参数要调整时：

```bash
python examples/dev-pet/make.py      # 需要 Pillow；输出可复现（同输入同字节）
python pipeline/validate_pet.py examples/dev-pet
```

> `make.py` 依赖同仓库的 `../dingdang-demo` 原始精灵表；不要把它当正式管线脚本用（正式管线在 `pipeline/`）。
