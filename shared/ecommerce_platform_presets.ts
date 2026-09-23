import type { EcommerceReportKind } from './ecommerce_workbench';

export type EcommercePlatformId = 'generic' | 'douyin' | 'taobao' | 'pinduoduo' | 'jd' | 'shopify';

export interface EcommercePlatformPreset {
  id: EcommercePlatformId;
  label: string;
  templates: Record<EcommerceReportKind, string[]>;
}

const STANDARD_TEMPLATES: Record<EcommerceReportKind, string[]> = {
  orders: ['订单号', 'SKU', '销售额', '商品成本', '运费', '平台服务费', '广告费', '退款金额', '商品数量'],
  campaigns: ['计划名称', '广告消耗', '成交金额', '成交订单数', '点击量', '曝光量'],
  inventory: ['SKU', '可售库存', '日均销量', '采购周期', '安全库存天数'],
  afterSales: ['SKU', '订单数', '退款单数', '退款金额', '投诉数'],
  reviews: ['SKU', '评价内容', '评分', '评价时间', '有用数'],
};

function templates(orderId: string, revenue: string, sku = 'SKU'): Record<EcommerceReportKind, string[]> {
  return {
    ...STANDARD_TEMPLATES,
    orders: [orderId, sku, revenue, '商品成本', '运费', '平台服务费', '广告费', '退款金额', '商品数量'],
  };
}

export const ECOMMERCE_PLATFORM_PRESETS: EcommercePlatformPreset[] = [
  { id: 'generic', label: '通用 / Generic', templates: STANDARD_TEMPLATES },
  { id: 'douyin', label: '抖店 / Douyin', templates: templates('主订单编号', '实付金额', '商家编码') },
  { id: 'taobao', label: '淘宝 / 天猫', templates: templates('订单编号', '买家实付金额', '商家编码') },
  { id: 'pinduoduo', label: '拼多多', templates: templates('订单号', '商品金额', '商家SKU编码') },
  { id: 'jd', label: '京东', templates: templates('订单号', '订单应付金额', '商家编码') },
  { id: 'shopify', label: 'Shopify', templates: templates('order id', 'net sales', 'variant sku') },
];

export function getEcommercePlatformPreset(id: EcommercePlatformId): EcommercePlatformPreset {
  return ECOMMERCE_PLATFORM_PRESETS.find(preset => preset.id === id) || ECOMMERCE_PLATFORM_PRESETS[0];
}

export function buildEcommerceTemplateCsv(platform: EcommercePlatformId, kind: EcommerceReportKind): string {
  const headers = getEcommercePlatformPreset(platform).templates[kind];
  return `\uFEFF${headers.map(header => /[",\r\n]/.test(header) ? `"${header.replace(/"/g, '""')}"` : header).join(',')}\r\n`;
}
