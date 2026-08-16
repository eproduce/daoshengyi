<script setup lang="ts">
import { computed } from "vue";
import { useChatStore } from "@/stores/chat";

const chat = useChatStore();

interface DayStat { date: string; tokens: number; cost: number; count: number }
interface ConvStat { id: string; title: string; tokens: number; cost: number; msgs: number }

// 从所有会话聚合统计（数据来自 SQLite 持久化的 tokens/duration/cost）
const totalStats = computed(() => {
  let conversations = 0, messages = 0, tokens = 0, cost = 0;
  let durationSec = 0, durationCount = 0;
  const convList: ConvStat[] = [];
  const dayMap = new Map<string, DayStat>();

  for (const c of chat.conversations) {
    conversations++;
    let ct = 0, cc = 0, cm = 0;
    for (const m of c.messages) {
      if (m.role !== "assistant") continue;
      messages++; cm++;
      const tk = m.tokens || 0;
      const cs = m.cost || 0;
      tokens += tk; cost += cs; ct += tk; cc += cs;
      if (m.duration) { durationSec += m.duration; durationCount++; }
      if (m.timestamp) {
        const d = new Date(m.timestamp);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const e = dayMap.get(key) ?? { date: key, tokens: 0, cost: 0, count: 0 };
        e.tokens += tk; e.cost += cs; e.count++;
        dayMap.set(key, e);
      }
    }
    convList.push({ id: c.id, title: c.title || "未命名会话", tokens: ct, cost: cc, msgs: cm });
  }

  const byDay = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    conversations, messages, tokens, cost,
    avgDuration: durationCount ? durationSec / durationCount : 0,
    convList: convList.filter((x) => x.tokens > 0 || x.cost > 0).sort((a, b) => b.tokens - a.tokens),
    byDay,
  };
});

// 缓存命中率（当前会话累计；无数据返回 null 表示暂不可用）
const cacheRate = computed<number | null>(() => {
  const total = chat.cacheHitTotal + chat.cacheMissTotal;
  return total > 0 ? (chat.cacheHitTotal / total) * 100 : null;
});
const cacheTokens = computed(() => chat.cacheHitTotal + chat.cacheMissTotal);

const maxDayTokens = computed(() => Math.max(1, ...totalStats.value.byDay.map((d) => d.tokens)));
const topConvs = computed(() => totalStats.value.convList.slice(0, 8));
const maxConvTokens = computed(() => Math.max(1, ...topConvs.value.map((c) => c.tokens)));

function fmtTokens(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : `${n}`;
}
function fmtCost(n: number): string {
  return `¥${n.toFixed(4)}`;
}
function fmtSec(n: number): string {
  return n >= 60 ? `${Math.floor(n / 60)}分${Math.round(n % 60)}秒` : `${n.toFixed(1)}秒`;
}
</script>

<template>
  <div class="usage-panel">
    <h3>📊 用量统计</h3>
    <p class="usage-desc">基于本地 SQLite 对话记录汇总（含每轮 token / 费用 / 耗时估算）</p>

    <!-- 概况卡片 -->
    <div class="usage-cards">
      <div class="usage-card">
        <div class="usage-card__num">{{ totalStats.conversations }}</div>
        <div class="usage-card__label">会话</div>
      </div>
      <div class="usage-card">
        <div class="usage-card__num">{{ totalStats.messages }}</div>
        <div class="usage-card__label">回复消息</div>
      </div>
      <div class="usage-card">
        <div class="usage-card__num">{{ fmtTokens(totalStats.tokens) }}</div>
        <div class="usage-card__label">总 Token</div>
      </div>
      <div class="usage-card">
        <div class="usage-card__num">{{ fmtCost(totalStats.cost) }}</div>
        <div class="usage-card__label">总费用</div>
      </div>
      <div class="usage-card">
        <div class="usage-card__num">{{ totalStats.avgDuration ? fmtSec(totalStats.avgDuration) : "--" }}</div>
        <div class="usage-card__label">平均响应</div>
      </div>
    </div>

    <!-- 缓存命中率 -->
    <div class="usage-block">
      <div class="usage-block__title">
        缓存命中率 <span class="usage-muted">（当前会话，{{ fmtTokens(cacheTokens) }} token）</span>
      </div>
      <div v-if="cacheRate !== null" class="cache-bar">
        <div class="cache-bar__fill" :style="{ width: cacheRate.toFixed(1) + '%' }"></div>
      </div>
      <div v-else class="usage-muted">尚无缓存数据（DeepSeek 前缀缓存，需多次提问后统计）</div>
      <div class="cache-nums">
        <span>命中 {{ fmtTokens(chat.cacheHitTotal) }}</span>
        <span v-if="cacheRate !== null">{{ cacheRate.toFixed(1) }}%</span>
        <span>未命中 {{ fmtTokens(chat.cacheMissTotal) }}</span>
      </div>
    </div>

    <!-- 按天 Token 趋势 -->
    <div class="usage-block">
      <div class="usage-block__title">每日 Token 消耗</div>
      <div v-if="totalStats.byDay.length" class="bar-chart" :style="{ height: '120px' }">
        <div v-for="d in totalStats.byDay" :key="d.date" class="bar-chart__col" :title="`${d.date}：${d.tokens} token / ${d.count} 条`">
          <div class="bar-chart__bar" :style="{ height: (d.tokens / maxDayTokens) * 100 + '%' }"></div>
          <div class="bar-chart__label">{{ d.date.slice(5) }}</div>
        </div>
      </div>
      <div v-else class="usage-muted">暂无数据</div>
    </div>

    <!-- 按会话 Token 分布 -->
    <div class="usage-block">
      <div class="usage-block__title">会话 Token 分布 <span class="usage-muted">（Top {{ topConvs.length }}）</span></div>
      <div v-if="topConvs.length" class="conv-bars">
        <div v-for="c in topConvs" :key="c.id" class="conv-row" :title="`${c.title}：${c.tokens} token / ¥${c.cost.toFixed(4)} / ${c.msgs} 条`">
          <div class="conv-row__name">{{ c.title }}</div>
          <div class="conv-row__track">
            <div class="conv-row__fill" :style="{ width: (c.tokens / maxConvTokens) * 100 + '%' }"></div>
          </div>
          <div class="conv-row__val">{{ fmtTokens(c.tokens) }}</div>
        </div>
      </div>
      <div v-else class="usage-muted">暂无数据</div>
    </div>
  </div>
</template>

<style scoped>
.usage-panel { display: flex; flex-direction: column; gap: 14px; }
.usage-desc { margin: 0 0 2px; font-size: 12px; color: #888; }
.usage-muted { color: #777; font-size: 12px; }

.usage-cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
.usage-card {
  background: #151528; border: 1px solid #2a2a45; border-radius: 8px;
  padding: 10px 8px; text-align: center;
}
.usage-card__num { font-size: 15px; font-weight: 700; color: var(--accent-color, #7c6cff); }
.usage-card__label { font-size: 11px; color: #999; margin-top: 2px; }

.usage-block {
  background: #131326; border: 1px solid #2a2a45; border-radius: 8px; padding: 12px;
}
.usage-block__title { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: #ddd; }

/* 缓存命中率 */
.cache-bar { height: 10px; background: #22223a; border-radius: 5px; overflow: hidden; }
.cache-bar__fill { height: 100%; background: linear-gradient(90deg, #4ade80, #22c55e); border-radius: 5px; transition: width .3s; }
.cache-nums { display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px; color: #aaa; }

/* 柱状图 */
.bar-chart { display: flex; align-items: flex-end; gap: 3px; }
.bar-chart__col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
.bar-chart__bar { width: 70%; background: linear-gradient(180deg, #7c6cff, #5a4bdb); border-radius: 3px 3px 0 0; min-height: 2px; }
.bar-chart__label { font-size: 9px; color: #777; margin-top: 4px; transform: rotate(-30deg); transform-origin: top left; }

/* 会话分布 */
.conv-bars { display: flex; flex-direction: column; gap: 6px; }
.conv-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.conv-row__name { width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #bbb; flex-shrink: 0; }
.conv-row__track { flex: 1; height: 14px; background: #22223a; border-radius: 4px; overflow: hidden; }
.conv-row__fill { height: 100%; background: linear-gradient(90deg, #7c6cff, #a78bfa); border-radius: 4px; min-width: 2px; }
.conv-row__val { width: 56px; text-align: right; color: #ccc; flex-shrink: 0; }
</style>
