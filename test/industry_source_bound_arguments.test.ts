import { describe, expect, it } from 'vitest';
import { parseEcommerceTodaySource } from '../server/industry/source_bound_arguments';

describe('labelled ecommerce source facts', () => {
  it('preserves operating amounts without inventing unlabelled costs or refund counts', () => {
    const facts = parseEcommerceTodaySource('销售额：120000元；订单：600单；广告花费：18000元；商品成本：54000元；平台及物流成本：12000元；退款：9000元');
    expect(facts).toMatchObject({ revenue: 120000, orders: 600, adSpend: 18000, cogs: 54000, shipping: 12000, refundAmount: 9000 });
    expect(facts.afterSalesCount).toBeUndefined();
  });

  it('never turns revenue into COGS or ad spend into shipping when costs are missing', () => {
    const source = '请为“稳定性验收店”执行今日经营分析。数据期间是2026年8月15日，币种CNY：订单120单，销售额36000元，广告花费7200元，退款金额3600元，售后8单；SKU-A库存6件，SKU-B库存80件。';
    expect(parseEcommerceTodaySource(source)).toMatchObject({
      revenue: 36000,
      orders: 120,
      adSpend: 7200,
      refundAmount: 3600,
      afterSalesCount: 8,
      reportingPeriod: '2026-08-15',
      currency: 'CNY',
      inventory: [
        { sku: 'SKU-A', stock: 6 },
        { sku: 'SKU-B', stock: 80 },
      ],
    });
    expect(parseEcommerceTodaySource(source).cogs).toBeUndefined();
    expect(parseEcommerceTodaySource(source).shipping).toBeUndefined();
  });

  it('parses a labelled compact Chinese inventory list without dropping SKUs', () => {
    const source = '\u5e97\u94fa\uff1a\u7a33\u5b9a\u6027\u9a8c\u6536\u5e97\uff1b\u9500\u552e\u989d\uff1a120000\u5143\uff1b\u8ba2\u5355\uff1a600\u5355\uff1b\u5e93\u5b58\uff1aSKU-A 8\u4ef6\uff0cSKU-B 120\u4ef6\u3002';
    expect(parseEcommerceTodaySource(source).inventory).toEqual([
      { sku: 'SKU-A', stock: 8 },
      { sku: 'SKU-B', stock: 120 },
    ]);
  });
});
