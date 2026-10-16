/**
 * 投屏的**宽松解析**回归测试。
 *
 * ★★ 为什么要单测这一层：投屏最容易翻车的地方就是"电视的 XML 长什么样"——
 *   命名空间前缀乱写、`URLBase` 缺失、`AVTransport` 埋在内嵌设备里、
 *   大小写不统一、缺字段…… 而这些**不用真机就能验**。
 *   （`src/cast/dlnaParse.ts` 与 `src/cast/xml.ts` 都不 import `react-native`，
 *     所以能直接跑在 vitest 的 node 环境里。）
 *
 * 原则：**从宽** —— 抠不出来就给空串 / null，绝不抛。
 */
import { describe, expect, it } from 'vitest';

import {
  buildMetadata,
  faultOf,
  guessControlUrl,
  normalizeState,
  parseDescription,
  resolveUrl,
  rootOf,
} from '../src/cast/dlnaParse';
import {
  allBlocks,
  attrOf,
  decodeEntities,
  parseRelTime,
  tagText,
  toRelTime,
} from '../src/cast/xml';

describe('xml：从宽取值', () => {
  it('认命名空间前缀，也认没有前缀的', () => {
    expect(tagText('<dc:title>你好</dc:title>', 'title')).toBe('你好');
    expect(tagText('<title>你好</title>', 'title')).toBe('你好');
    expect(tagText('<DIDL-Lite><dc:title>你好</dc:title></DIDL-Lite>', 'title')).toBe('你好');
  });

  it('标签大小写不敏感', () => {
    expect(tagText('<FriendlyName>客厅电视</FriendlyName>', 'friendlyName')).toBe('客厅电视');
  });

  it('解实体，且 &amp; 最后解（防二次解码）', () => {
    expect(decodeEntities('a&amp;b')).toBe('a&b');
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('&#39;')).toBe("'");
    expect(decodeEntities('&#x27;')).toBe("'");
    expect(tagText('<t>A &amp; B</t>', 't')).toBe('A & B');
  });

  it('抠不出就回空串，不抛', () => {
    expect(tagText('完全不是 xml', 'title')).toBe('');
    expect(tagText('<title>没闭合', 'title')).toBe('');
    expect(attrOf('<a>', 'x')).toBe('');
  });

  it('allBlocks 能取多个，且不会死循环', () => {
    const xml = '<service>1</service><service>2</service>';
    expect(allBlocks(xml, 'service')).toHaveLength(2);
  });

  it('attrOf 单双引号都认', () => {
    expect(attrOf('<x a="1" b=\'2\'>', 'a')).toBe('1');
    expect(attrOf('<x a="1" b=\'2\'>', 'b')).toBe('2');
    expect(attrOf('<x A="1">', 'a')).toBe('1');
  });

  it('REL_TIME 解析：认毫秒、认短格式；认不出回 null（不是 0）', () => {
    expect(parseRelTime('00:01:23')).toBe(83);
    expect(parseRelTime('0:01:23.500')).toBeCloseTo(83.5);
    expect(parseRelTime('1:00:00')).toBe(3600);
    expect(parseRelTime('NOT_IMPLEMENTED')).toBeNull();
    expect(parseRelTime('')).toBeNull();
    expect(toRelTime(3725)).toBe('1:02:05');
  });
});

describe('dlnaParse：设备描述', () => {
  const descriptionUrl = 'http://192.168.1.20:49152/description.xml';

  it('标准写法：根设备里的 AVTransport', () => {
    const xml = `<?xml version="1.0"?>
      <root xmlns="urn:schemas-upnp-org:device-1-0">
        <device>
          <friendlyName>客厅电视</friendlyName>
          <UDN>uuid:abc-123</UDN>
          <serviceList>
            <service>
              <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
              <controlURL>/upnp/control/AVTransport1</controlURL>
            </service>
          </serviceList>
        </device>
      </root>`;
    const parsed = parseDescription(xml, descriptionUrl);
    expect(parsed).not.toBeNull();
    expect(parsed!.friendlyName).toBe('客厅电视');
    expect(parsed!.udn).toBe('uuid:abc-123');
    expect(parsed!.controlUrl).toBe('http://192.168.1.20:49152/upnp/control/AVTransport1');
    expect(parsed!.serviceType).toBe('urn:schemas-upnp-org:service:AVTransport:1');
  });

  it('★ AVTransport 埋在内嵌设备里也找得到（只扫根节点就会漏）', () => {
    const xml = `<root><device>
        <friendlyName>盒子</friendlyName>
        <deviceList><device>
          <serviceList><service>
            <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
            <controlURL>/AVTransport/control</controlURL>
          </service></serviceList>
        </device></deviceList>
      </device></root>`;
    const parsed = parseDescription(xml, descriptionUrl);
    expect(parsed!.controlUrl).toBe('http://192.168.1.20:49152/AVTransport/control');
  });

  it('★ 服务版本号不是 1 也认（有的电视只认自己的版本）', () => {
    const xml = `<root><device><serviceList><service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:3</serviceType>
        <controlURL>/ctl</controlURL>
      </service></serviceList></device></root>`;
    const parsed = parseDescription(xml, descriptionUrl);
    expect(parsed!.serviceType).toBe('urn:schemas-upnp-org:service:AVTransport:3');
    expect(parsed!.controlUrl).toBe('http://192.168.1.20:49152/ctl');
  });

  it('★ serviceType 乱写、但控制路径里写着 AVTransport —— 也认', () => {
    const xml = `<root><device><serviceList><service>
        <serviceType></serviceType>
        <controlURL>/AVTransport/control</controlURL>
      </service></serviceList></device></root>`;
    const parsed = parseDescription(xml, descriptionUrl);
    expect(parsed!.controlUrl).toBe('http://192.168.1.20:49152/AVTransport/control');
    expect(parsed!.serviceType).toBe('urn:schemas-upnp-org:service:AVTransport:1');
  });

  it('★ 带 URLBase 时按它解析相对地址', () => {
    const xml = `<root><URLBase>http://10.0.0.5:1234/</URLBase><device><serviceList><service>
        <serviceType>AVTransport</serviceType>
        <controlURL>ctl/avt</controlURL>
      </service></serviceList></device></root>`;
    const parsed = parseDescription(xml, descriptionUrl);
    expect(parsed!.controlUrl).toBe('http://10.0.0.5:1234/ctl/avt');
  });

  it('★ 一个 service 都没有 —— 兜底猜常见控制路径（不直接放弃）', () => {
    const xml = '<root><device><friendlyName>怪电视</friendlyName></device></root>';
    const parsed = parseDescription(xml, descriptionUrl);
    expect(parsed!.controlUrl).toBe('http://192.168.1.20:49152/AVTransport/control');
    expect(parsed!.friendlyName).toBe('怪电视');
  });

  it('★ 缺 friendlyName / UDN 也**不丢设备**（调用方会用主机名兜底）', () => {
    const xml = `<root><device><serviceList><service>
        <serviceType>AVTransport</serviceType><controlURL>/ctl</controlURL>
      </service></serviceList></device></root>`;
    const parsed = parseDescription(xml, descriptionUrl);
    expect(parsed).not.toBeNull();
    expect(parsed!.friendlyName).toBe('');
    expect(parsed!.udn).toBe('');
  });

  it('描述地址本身解析不出来时回 null（不抛）', () => {
    expect(parseDescription('不是 xml', descriptionUrl)).toBeNull();
  });
});

describe('dlnaParse：地址解析', () => {
  it('三种相对形态都认', () => {
    const base = 'http://10.0.0.5:1234/desc/device.xml';
    expect(resolveUrl(base, '/ctl')).toBe('http://10.0.0.5:1234/ctl');
    expect(resolveUrl(base, 'ctl')).toBe('http://10.0.0.5:1234/desc/ctl');
    expect(resolveUrl(base, 'http://other:9/x')).toBe('http://other:9/x');
    expect(resolveUrl(base, '')).toBe('');
  });

  it('rootOf 取 scheme://host:port', () => {
    expect(rootOf('http://10.0.0.5:1234/a/b')).toBe('http://10.0.0.5:1234');
    expect(rootOf('乱写')).toBe('');
  });

  it('guessControlUrl 拿不到根地址就回空串', () => {
    expect(guessControlUrl('乱写')).toBe('');
  });
});

describe('dlnaParse：SOAP', () => {
  it('状态归一化：认不出的回 unknown，不瞎猜', () => {
    expect(normalizeState('PLAYING')).toBe('playing');
    expect(normalizeState('PAUSED_PLAYBACK')).toBe('paused');
    expect(normalizeState('STOPPED')).toBe('stopped');
    expect(normalizeState('NO_MEDIA_PRESENT')).toBe('stopped');
    expect(normalizeState('TRANSITIONING')).toBe('transitioning');
    expect(normalizeState('')).toBe('unknown');
    expect(normalizeState('随便什么')).toBe('unknown');
  });

  it('faultOf：只有真 Fault 才算，普通响应回空串', () => {
    const fault = `<s:Envelope><s:Body><s:Fault>
      <faultcode>s:Client</faultcode><faultstring>Invalid Args</faultstring>
      </s:Fault></s:Body></s:Envelope>`;
    expect(faultOf(fault)).toBe('Invalid Args');
    expect(faultOf('<Envelope><Body><PlayResponse/></Body></Envelope>')).toBe('');
  });

  it('buildMetadata 转义 URL 与标题里的特殊字符', () => {
    const xml = buildMetadata('http://h/a?x=1&y=2', 'A & B <剧>');
    expect(xml).toContain('http://h/a?x=1&amp;y=2');
    expect(xml).toContain('A &amp; B &lt;剧&gt;');
    // 不能出现未转义的裸 & 跟着非实体字符
    expect(/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml)).toBe(false);
  });
});
