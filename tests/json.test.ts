import { describe, expect, it } from 'vitest';
import { extractJsonText, parseJsonLoose, parseLineList } from '../src/ai/json';

describe('extractJsonText', () => {
  it('从纯 JSON 中提取对象', () => {
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
  });

  it('剥离 ```json 围栏与前后废话', () => {
    const text = '好的，结果如下：\n```json\n{"a":[1,2]}\n```\n以上。';
    expect(extractJsonText(text)).toBe('{"a":[1,2]}');
  });

  it('字符串里的括号不干扰配平', () => {
    const text = '说明 { "note": "这里有 } 括号", "ok": true } 结束';
    expect(extractJsonText(text)).toBe('{ "note": "这里有 } 括号", "ok": true }');
  });

  it('优先返回数组', () => {
    expect(extractJsonText('[{"i":0,"t":"译文"}]')).toBe('[{"i":0,"t":"译文"}]');
  });

  it('没有 JSON 时返回 null', () => {
    expect(extractJsonText('完全没有结构化输出')).toBeNull();
  });
});

describe('parseJsonLoose', () => {
  it('解析数组', () => {
    const parsed = parseJsonLoose<{ i: number; t: string }[]>('[{"i":0,"t":"你好"}]');
    expect(parsed?.[0].t).toBe('你好');
  });

  it('容忍尾随逗号', () => {
    const parsed = parseJsonLoose<{ a: number }>('{"a": 1,}');
    expect(parsed?.a).toBe(1);
  });

  it('无法解析时返回 null 而不是抛错', () => {
    expect(parseJsonLoose('{坏掉的')).toBeNull();
  });
});

describe('parseLineList', () => {
  it('去掉编号与项目符号', () => {
    const items = parseLineList('1. 问题是什么\n- 方法如何\n• 结论');
    expect(items).toEqual(['问题是什么', '方法如何', '结论']);
  });
});
