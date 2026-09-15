import { it, expect, describe } from "vitest";
import { tokenize, BM25Index, buildToolSearchText } from "../src/utils/tool-search.ts";

describe("tokenize", () => {
  it("英文/标识符按词切分并小写（下划线拆词，便于查 run 命中 workflow_run）", () => {
    expect(tokenize("workflow_run")).toEqual(["workflow", "run"]);
    expect(tokenize("Read File")).toEqual(["read", "file"]);
  });

  it("中文切单字 + 相邻双字（无需分词词典）", () => {
    const tokens = tokenize("数据库");
    expect(tokens).toContain("数");
    expect(tokens).toContain("数据");
    expect(tokens).toContain("据库");
  });

  it("中英混合、标点与空串都能处理", () => {
    // ASCII 词先出；CJK 按连续片段切「单字 + 相邻双字」（"查数据库" → 查/查数/数/数据/据/据库/库）
    expect(tokenize("用 PostgreSQL 查数据库")).toEqual([
      "postgresql",
      "用",
      "查",
      "查数",
      "数",
      "数据",
      "据",
      "据库",
      "库",
    ]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("BM25Index", () => {
  const docs = [
    {
      id: "pg_query",
      text: buildToolSearchText("pg_query", "在 PostgreSQL 数据库执行只读 SQL 查询", "postgres"),
    },
    {
      id: "redis_get",
      text: buildToolSearchText("redis_get", "读取 Redis 键值（缓存查询）", "redis"),
    },
    {
      id: "send_email",
      text: buildToolSearchText("send_email", "发送电子邮件（SMTP）", "mail"),
    },
  ];
  const index = new BM25Index(docs);

  it("英文关键词命中对应工具", () => {
    expect(index.search("postgresql")[0].id).toBe("pg_query");
    expect(index.search("redis")[0].id).toBe("redis_get");
  });

  it("中文自然语言命中对应工具（bigram 生效）", () => {
    expect(index.search("数据库查询")[0].id).toBe("pg_query");
    expect(index.search("发邮件")[0].id).toBe("send_email");
  });

  it("按工具名检索时名字权重更高（名字在正文里出现两次）", () => {
    expect(index.search("send_email")[0].id).toBe("send_email");
  });

  it("无相关词返回空；limit 生效且按分数降序", () => {
    expect(index.search("完全无关的词儿")).toEqual([]);
    expect(index.search("", 5)).toEqual([]);
    const hits = index.search("查询", 1);
    expect(hits.length).toBe(1);
  });

  it("空索引不抛异常", () => {
    const empty = new BM25Index([]);
    expect(empty.size).toBe(0);
    expect(empty.search("任意")).toEqual([]);
  });
});
