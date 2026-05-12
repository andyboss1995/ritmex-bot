# Leader-Rider 子策略：18 个月回测验证报告

**回测日期**：2026-05-12  
**数据范围**：2024-11-13 → 2026-05-07（18 个月，含港股牛市主升段）  
**数据**：`data/hk_universe_kline.json`（185 只股票 × 362 交易日，按流动性筛选的 Top 200 港股）  
**初始资金**：1,000,000 HKD（虚拟）+ 20,000 HKD 实盘可行性诊断  
**费用**：双边 25 bps（印花税 0.13% + 佣金 + 滑点合计估算）

## 1. 核心结论

| 比较对象 | 总收益 | CAGR | Sharpe | MaxDD | 备注 |
|---|---|---|---|---|---|
| **Universe 等权 Buy & Hold** | **+70%** | ~+44% | — | 估 25-30% | beta 上限 |
| 原 hk-momentum-policy（保守组） | ~+25% | ~+16% | 1.0 | ~8% | 短线波段 |
| **★ Leader-Rider 最佳组合** | **+50%** | +32.6% | **1.50** | **14.8%** | maxPos=3 + RS Top 30% |
| Leader-Rider 平衡组 | +27% | +18% | 1.26 | 13.8% | risk 2% + atrStop 3× |
| Leader-Rider 最稳组（推荐 20k 实盘） | +12% | +8% | 0.79 | **7.7%** | maxPos=2 + risk 2% |

## 2. 推荐参数（按风险偏好）

### 进取组合（适合 ≥ 100k HKD）
```ts
{
  maxPositions: 3,
  perTradeRiskPct: 0.025,
  rsRankTopPct: 0.30,           // RS Top 30%
  minNewHighsLast20: 2,
  maxDaysSinceHigh: 8,
  atrStopMult: 2.5,
  chandelierMult: 2.5,
  trailingMode: "chandelier",
  exitOnEma21Break: true,
  entryMode: "pullback",        // 等回踩 EMA10
}
```
**18 月预期：** +50% 收益，14.8% maxDD，Sharpe 1.50。

### 平衡组合（适合 50-100k HKD）
```ts
{
  ...进取组合,
  perTradeRiskPct: 0.02,
  rsRankTopPct: 0.25,
  atrStopMult: 3.0,
  chandelierMult: 3.0,
}
```
**18 月预期：** +27% 收益，13.8% maxDD，Sharpe 1.26。

### 最稳组合（推荐 20k HKD 测试用）
```ts
{
  maxPositions: 2,              // 受小账户 lot size 限制
  perTradeRiskPct: 0.02,        // 单笔风险 400 HKD
  rsRankTopPct: 0.15,
  minNewHighsLast20: 2,
  atrStopMult: 3.0,
  chandelierMult: 3.0,
  exitOnEma21Break: true,
  entryMode: "pullback",
}
```
**18 月预期：** +12% 收益（≈ 2,360 HKD），**7.7% maxDD**，Sharpe 0.79，47 笔。

---

## 3. 重要诚实声明

### 3.1 策略 **未跑赢** 等权 Buy & Hold（+50% vs +70%）

原因：
- 18 月数据是**港股大牛市**，universe 经过流动性筛选自带强 beta
- 策略保留 0.7-3% 现金（曝险率 95-99%），轻微 drag
- 退出机制会卖飞主升浪（如 INNOVENT BIO 51 天 +52% 触发 chandelier 退出，否则可能再涨 50%）

### 3.2 策略真正的价值 = **风险控制 + 熊市保护**

- 最佳组合 maxDD 14.8% vs 等权 buy-hold 估计 25-30%
- Sharpe 1.50 vs buy-hold 估计 0.7-0.9
- **18 月数据没有港股熊市，策略的下行保护未被验证**
- 真正考验：2026 年若进入 -20% 系统下跌，策略应表现远好于 buy-hold

### 3.3 20k HKD 实盘的现实问题

**Lot size 限制：**
- 港股 RS Top 30% 多为 $50-300 股票，1 手 = 100 股 = 5k-30k HKD
- 20k 资金最多开 1-2 仓（实盘 maxPos=2 现实），且会出现"满仓 1 只 + 现金 5k"局面
- 单笔风险 400 HKD（2%），意味着可承受 ~1.5-3% 价格回撤
- **实际表现可能偏离回测**：滑点比例放大、整数 lot 取整损失大

**18 月预期收益**：~2,360 HKD（11.8%），**月均 130 HKD**  
**对照无风险**：HKD 定存 ~3% 年化 → 18 月 ~1,000 HKD  
**净 alpha**：~1,300 HKD ÷ 18 月 = **每月 70 HKD**

**结论**：20k 资金太小，难以体现策略效果，但**作为 SIMULATE 逻辑验证 + 实盘下单链路测试是足够的**。

---

## 4. 已知风险与限制

1. **未含熊市样本**：18 月数据从 2024Q4 启动，全程牛市/震荡上行
2. **生存者偏差**：universe 是当下 Top 200 流动股，已排除退市/边缘化标的
3. **滑点未充分计入**：25 bps 假设可能低估，特别是低流动性时段
4. **回测无法模拟集合竞价滑点**：实盘开盘价可能偏离回测假设的 open
5. **EMA21 退出机制对快速反转友好但对噪音敏感**：连续 4-5% 回撤再涨的强势股会被洗掉
6. **样本量警告**：单组合 50-65 笔交易，t 检验置信度只有 80%，前 1-3 个月实盘偏差 ±50% 属正常

---

## 5. 对比 hk-momentum-policy（原政策催化策略）

| 维度 | hk-momentum-policy | hk-leader-rider |
|---|---|---|
| 持仓周期 | 1-3 天 | 8-50 天（平均 10 天） |
| 入场触发 | 量价突破 + 强催化关键词 | 60 日新高 + RS + 回踩 EMA10 |
| 信号频次 | 月均 3-5 笔 | 月均 5-7 笔 |
| 单笔目标 | 5% 部分止盈 | 跟踪到趋势破坏 |
| 主要 Alpha | 政策催化的隔夜跳空 | 强势股的趋势惯性 |
| 6 月真实回测 | +8.5% | +50%（18 月折合 +33%） |
| 数据依赖 | 必须 AKShare 实时新闻 | 仅需 K 线数据 |

**协同建议**：60% 资金跑 hk-momentum-policy（高频小波段）+ 40% 资金跑 hk-leader-rider（趋势延展），两者相关性低（一个吃催化、一个吃惯性）。

---

## 6. 下一步行动建议

### 立即可做（验证用 20k）
1. ✅ 已写好 `scripts/hk-leader-scan.ts`：每天扫描候选清单
2. ✅ 已写好 `scripts/hk-leader-backtest.ts`：回测器可重跑
3. 🔜 需写 `scripts/hk-leader-live.ts`：复用 FutuTradeBridge 实盘下单
4. 🔜 加入 launchd 每日自动调度

### 中期（实盘 1-3 月后）
1. 观测真实滑点（vs 回测假设的 open）
2. 检查 RS Top 30% 在轮动市场是否有效
3. 决定是否上 pyramid 加仓

### 长期（验证 OK 后）
1. 把 20k 升级到 100k+ 才能稳定开 3 仓
2. 加入熊市保护规则（指数跌破 200 日均线后只开 1 仓）
3. 与 hk-momentum-policy 资金分配优化

---

## 7. 一键复现命令

```bash
# 扫今日候选
bun run scripts/hk-leader-scan.ts --top 25

# 跑 18 月完整回测
bun run scripts/hk-leader-backtest.ts --compare

# 参数扫描
bun run scripts/hk-leader-tune.ts
```
