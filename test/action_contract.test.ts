import { describe, expect, it } from 'vitest';
import {
  buildActionContract,
  formatActionContractPrompt,
  hasCoreActionEvidence,
  hasAuthenticatedWebResultEvidence,
  hasVisibleAutoCadExecutionEvidence,
  requiresAutoCadMcpPlayback,
  requiresAuthenticatedWebResult,
  requiresVisibleAutoCadExecution,
} from '../server/cognition/action_contract';

describe('Lumi action contract', () => {
  it('classifies foreground messaging as a send contract', () => {
    const contract = buildActionContract('\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89');

    expect(contract.kind).toBe('messaging_send');
    expect(contract.preferredTools).toContain('wechat_send_message');
    expect(contract.requiredEvidence.join(' ')).toContain('sent=true');
    expect(hasCoreActionEvidence(contract, [{
      id: '1',
      name: 'desktop_open',
      arguments: { target: '\u5fae\u4fe1' },
      result: 'Opened WeChat',
    }])).toBe(false);
    expect(hasCoreActionEvidence(contract, [{
      id: '2',
      name: 'wechat_send_message',
      arguments: {},
      result: '{"sent":true}',
    }])).toBe(true);
  });

  it('does not turn a negated message boundary into a send contract', () => {
    const contract = buildActionContract(
      'Inspect running desktop AI applications and report detected evidence. Do not open apps, click, type, or send messages.',
    );

    expect(contract.kind).toBe('desktop_operation');
    expect(contract.preferredTools).not.toContain('wechat_send_message');
  });

  it('does not let injected attachment prose reclassify a CAD task as messaging', () => {
    const text = [
      '把这幅图画成cad图',
      '## Current Turn Attachments',
      'The user attached these files to the current message. Treat them as part of the user request.',
      'Local path: C:\\Users\\me\\LumiOS\\data\\knowledge\\plan.jpg',
    ].join('\n\n');
    const contract = buildActionContract(text);

    expect(contract.kind).toBe('cad_drafting');
    expect(requiresVisibleAutoCadExecution(text)).toBe(true);
    expect(contract.preferredTools).toContain('mcp_cad-drafting_autocad_playback_file');
    expect(contract.preferredTools).not.toContain('cad_generate_dxf');
    expect(contract.preferredTools).not.toContain('wechat_send_message');
  });

  it('treats message as a send action only when it has a directed recipient', () => {
    expect(buildActionContract('Message Alice that I will arrive at three.').kind).toBe('messaging_send');
    expect(buildActionContract('The current message has an image attachment.').kind).not.toBe('messaging_send');
    expect(buildActionContract("Reply with exactly 'OK' and nothing else.").kind).not.toBe('messaging_send');
  });

  it('treats directed person-to-person sends as real messaging work', () => {
    const contract = buildActionContract('\u7ed9\u5f20\u4e09\u53d1\u4e0b\u5348\u4e09\u70b9\u5f00\u4f1a');

    expect(contract.kind).toBe('messaging_send');
    expect(contract.coreAction).toContain('recipient');
    expect(hasCoreActionEvidence(contract, [{
      id: '1',
      name: 'desktop_active_window',
      arguments: {},
      result: 'WeChat is active',
    }])).toBe(false);
  });

  it('accepts a matching verified WeChat file delivery without confusing it with a text send', () => {
    const task = '\u628a\u9886\u822a\u5458\u8ba1\u52122026\u53d1\u7ed9\u6211';
    const contract = buildActionContract(task);
    const delivered = {
      id: 'file-send-1',
      name: 'wechat_send_file',
      arguments: { filePath: 'C:\\Users\\owner\\Desktop\\\u9886\u822a\u5458\u8ba1\u52122026.docx' },
      result: JSON.stringify({
        sent: true,
        verificationStatus: 'provider_accepted',
        verificationMethod: 'wechat_ilink_provider_ack',
        fileName: '\u9886\u822a\u5458\u8ba1\u52122026.docx',
        messageId: 'wx-file-1',
      }),
    };

    expect(contract.kind).toBe('messaging_send');
    expect(contract.preferredTools).toContain('wechat_send_file');
    expect(contract.requiredEvidence.join(' ')).toContain('wechat_send_file');
    expect(hasCoreActionEvidence(contract, [delivered], task)).toBe(true);
    expect(hasCoreActionEvidence(contract, [{
      ...delivered,
      arguments: { filePath: 'C:\\Users\\owner\\Desktop\\\u5176\u4ed6\u6587\u4ef6.docx' },
      result: JSON.stringify({ sent: true, fileName: '\u5176\u4ed6\u6587\u4ef6.docx' }),
    }], task)).toBe(false);
  });

  it('classifies foreground chat reading separately from sending', () => {
    const contract = buildActionContract('\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9');

    expect(contract.kind).toBe('messaging_read');
    expect(contract.preferredTools).toContain('wechat_read_recent_chat');
    expect(contract.preferredTools).not.toContain('wechat_send_message');
    expect(hasCoreActionEvidence(contract, [{
      id: '1',
      name: 'desktop_open',
      arguments: { target: '\u5fae\u4fe1' },
      result: 'Focused WeChat',
    }])).toBe(false);
    expect(hasCoreActionEvidence(contract, [{
      id: '2',
      name: 'wechat_read_recent_chat',
      arguments: { contact: '\u963f\u9646' },
      result: '{"read":true,"contentSummary":"visible chat"}',
    }])).toBe(true);
  });

  it('creates non-messaging contracts for other real-world actions', () => {
    expect(buildActionContract('\u6253\u5f00\u6d4f\u89c8\u5668\u81ea\u52a8\u767b\u5f55').kind).toBe('browser_account');
    expect(buildActionContract('\u89c6\u9891\u7f51\u7ad9\u81ea\u52a8\u8bc4\u8bba').kind).toBe('public_post');
    expect(buildActionContract('CAD\u81ea\u52a8\u753b\u56fe').kind).toBe('cad_drafting');
    expect(buildActionContract('\u5e2e\u6211\u76ef\u76d8\u80a1\u7968').kind).toBe('stock_monitor');
    expect(buildActionContract('\u5f8b\u5e08\u7684\u4ee3\u7406\u8bcd').kind).toBe('legal_document');
    const legalMeeting = buildActionContract('\u628a\u8fd9\u6b21\u529e\u6848\u4f1a\u8bae\u6574\u7406\u6210\u6848\u4ef6\u4f1a\u8bae\u7eaa\u8981');
    expect(legalMeeting.kind).toBe('legal_document');
    expect(legalMeeting.preferredTools).toContain('legal_meeting_minutes_to_case');
    const legalReasoning = buildActionContract('\u6309\u4e09\u6bb5\u8bba\u505a\u4e00\u4efd\u6848\u4ef6\u6cd5\u5f8b\u5206\u6790');
    expect(legalReasoning.kind).toBe('legal_document');
    expect(legalReasoning.coreAction).toContain('\u4e09\u6bb5\u8bba');
    expect(legalReasoning.requiredEvidence).toContain('\u4e09\u6bb5\u8bba\u63a8\u7406\u94fe/\u6cd5\u5f8b\u4f9d\u636e-\u4e8b\u5b9e\u8bc1\u636e-\u6db5\u6444\u7ed3\u8bba\u8bc1\u636e');
    expect(legalReasoning.preferredTools).toContain('legal_case_reasoning_matrix');
    expect(legalReasoning.verificationTools).toContain('legal_case_reasoning_matrix');
    const legalAssetTrace = buildActionContract('\u67e5\u88ab\u6267\u884c\u4eba\u8d22\u4ea7\u7ebf\u7d22\u548c\u80a1\u6743\u7a7f\u900f');
    expect(legalAssetTrace.kind).toBe('legal_document');
    expect(legalAssetTrace.preferredTools).toContain('legal_trace_assets');
    expect(legalAssetTrace.preferredTools).toContain('legal_equity_penetration');
    const legalRemoteIntake = buildActionContract('\u98de\u4e66\u53d1\u7ed9 Lumi bot \u7684\u6cd5\u9662\u77ed\u4fe1\u94fe\u63a5\uff0c\u81ea\u52a8\u5165\u6848');
    expect(legalRemoteIntake.kind).toBe('legal_document');
    expect(legalRemoteIntake.preferredTools).toContain('legal_message_intake_to_case');
    expect(legalRemoteIntake.preferredTools).toContain('legal_generate_citation_verification_report');
  });

  it('classifies customer, ecommerce, and composite design work as evidence-gated operations', () => {
    expect(buildActionContract('Analyze this customer lead and advance the sales follow-up.').kind).toBe('customer_operations');
    expect(buildActionContract('Analyze this ecommerce campaign ROI and optimize the store listing.').kind).toBe('ecommerce_operations');
    expect(buildActionContract('Create a full interior design package with a PPT, renders, and budget schedule.').kind).toBe('design_delivery');
    expect(buildActionContract('Create a store publish draft but do not publish it.').kind).toBe('ecommerce_operations');
    expect(buildActionContract('客户微信：接管抖店账号，分析广告并准备短视频脚本。').kind).toBe('ecommerce_operations');
    expect(buildActionContract('根据客户发来的户型图完成装修设计交付。').kind).toBe('design_delivery');
  });

  it('does not accept local takeover packages as customer or ecommerce completion evidence', () => {
    const customerText = 'Analyze this customer lead and score the sales opportunity.';
    const customer = buildActionContract(customerText);
    expect(hasCoreActionEvidence(customer, [{
      id: 'customer-package',
      name: 'legacy_scripted_customer_package',
      arguments: {},
      result: '{"artifactReady":true,"completionEligible":false}',
    }], customerText)).toBe(false);
    expect(hasCoreActionEvidence(customer, [{
      id: 'lead-analysis',
      name: 'mcp_sales-customer-ops_lead_score',
      arguments: { leadText: 'Customer asked for a 30-seat annual plan and a quote.' },
      result: '{"grade":"A","signals":["budget","timeline"],"nextAction":"prepare scoped proposal"}',
    }], customerText)).toBe(true);

    const followUpText = 'Analyze this customer lead and advance the sales follow-up.';
    const followUp = buildActionContract(followUpText);
    expect(hasCoreActionEvidence(followUp, [{
      id: 'lead-only',
      name: 'mcp_sales-customer-ops_lead_score',
      arguments: { leadText: 'Customer requested a quote.' },
      result: '{"grade":"hot","nextBestAction":"follow up"}',
    }], followUpText)).toBe(false);
    expect(hasCoreActionEvidence(followUp, [{
      id: 'lead-analysis',
      name: 'mcp_sales-customer-ops_lead_score',
      arguments: { leadText: 'Customer requested a quote.' },
      result: '{"grade":"hot","nextBestAction":"follow up"}',
    }, {
      id: 'sent-follow-up',
      name: 'wechat_send_message',
      arguments: { contact: 'Customer', message: 'Here is the requested next step.' },
      result: '{"sent":true,"verificationStatus":"verified"}',
    }], followUpText)).toBe(true);

    const ecommerceText = 'Analyze this ecommerce campaign ROI.';
    const ecommerce = buildActionContract(ecommerceText);
    expect(hasCoreActionEvidence(ecommerce, [{
      id: 'growth-package',
      name: 'legacy_scripted_ecommerce_package',
      arguments: {},
      result: '{"artifactReady":true,"completionEligible":false}',
    }], ecommerceText)).toBe(false);
    expect(hasCoreActionEvidence(ecommerce, [{
      id: 'roi',
      name: 'mcp_ecommerce-ops_campaign_roi_analyzer',
      arguments: { campaignText: 'Campaign A spend 300 revenue 1500 orders 20.' },
      result: '{"roas":5,"contributionAfterAds":225,"recommendation":"scale within margin guardrail"}',
    }], ecommerceText)).toBe(true);
  });

  it('requires every requested design output and source inspection', () => {
    const text = 'Based on the attached PDF, create an interior design PPT and finished render.';
    const contract = buildActionContract(text);
    const draftOnly = [{
      id: 'package',
      name: 'legacy_scripted_design_package',
      arguments: {},
      result: '{"artifactReady":true,"completionEligible":false}',
    }];
    const completed = [{
      id: 'read',
      name: 'read_pdf',
      arguments: { path: 'D:\\brief.pdf' },
      result: 'Extracted room dimensions and design constraints.',
    }, {
      id: 'ppt',
      name: 'create_ppt',
      arguments: { title: 'Interior concept' },
      result: 'created: D:\\output\\concept.pptx',
    }, {
      id: 'render',
      name: 'generate_image',
      arguments: { prompt: 'Interior render grounded in the supplied brief' },
      result: '{"image_url":"https://example.test/render.png"}',
    }, {
      id: 'verify',
      name: 'work_product_verify',
      arguments: {},
      result: '{"status":"pass","artifactChecks":[{"path":"D:\\\\output\\\\concept.pptx","exists":true}]}',
    }];

    expect(contract.kind).toBe('design_delivery');
    expect(hasCoreActionEvidence(contract, draftOnly, text)).toBe(false);
    expect(hasCoreActionEvidence(contract, completed, text)).toBe(true);
  });

  it('does not accept an underspecified full-design package as complete', () => {
    const text = 'Complete the full interior design delivery package.';
    const contract = buildActionContract(text);
    const oneDocument = [{
      id: 'ppt',
      name: 'create_ppt',
      arguments: { title: 'Generic interior concept' },
      result: 'created: D:\\output\\generic.pptx',
    }, {
      id: 'verify',
      name: 'work_product_verify',
      arguments: {},
      result: '{"status":"pass","artifactChecks":[{"path":"D:\\\\output\\\\generic.pptx","exists":true}]}',
    }];

    expect(contract.kind).toBe('design_delivery');
    expect(hasCoreActionEvidence(contract, oneDocument, text)).toBe(false);
  });

  it('requires a public commit plus post-submit page feedback', () => {
    const text = 'Post this comment on the video website.';
    const contract = buildActionContract(text);
    expect(hasCoreActionEvidence(contract, [{
      id: 'open',
      name: 'mcp_playwright_browser_snapshot',
      arguments: {},
      result: 'Video page with comment box.',
    }], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [{
      id: 'commit',
      name: 'mcp_playwright_browser_click',
      arguments: { element: 'Post comment button' },
      result: 'Clicked the post comment button.',
    }, {
      id: 'receipt',
      name: 'mcp_playwright_browser_snapshot',
      arguments: {},
      result: 'Comment is visible. Posted successfully.',
    }], text)).toBe(true);
  });

  it('requires stronger evidence when the user asks for visible AutoCAD execution', () => {
    const text = '\u684c\u9762\u4e0a\u6709\u4e2a\u300c\u963f\u9646\u300d\u6587\u4ef6\u5939\uff0c\u6839\u636e\u91cc\u9762\u7684\u56fe\u7247\u751f\u6210 CAD \u56fe\u7eb8\uff0c\u5e76\u5728 AutoCAD \u91cc\u5b9e\u9645\u753b\u51fa\u6765';

    expect(requiresVisibleAutoCadExecution(text)).toBe(true);
    expect(hasVisibleAutoCadExecutionEvidence([{
      id: 'folder',
      name: 'mcp_cad-drafting_cad_renovation_folder_workflow',
      arguments: {},
      result: '{"cadFiles":[{"path":"C:\\\\Users\\\\me\\\\Desktop\\\\plan.dxf"}]}',
    }])).toBe(false);
    expect(hasVisibleAutoCadExecutionEvidence([{
      id: 'run',
      name: 'legacy_autocad_batch',
      arguments: { scriptPath: 'C:\\\\Users\\\\me\\\\Desktop\\\\plan.scr' },
      result: '{"status":"completed","completionMarkerExists":true}',
    }])).toBe(false);
    expect(hasVisibleAutoCadExecutionEvidence([{
      id: 'mcp-run',
      name: 'mcp_cad-drafting_autocad_playback_file',
      arguments: { operationsPath: 'C:\\Users\\me\\Desktop\\plan_operations.json' },
      result: '{"status":"completed","transport":"mcp_autocad_com","visiblePlayback":true,"completionMarkerExists":true,"geometryVerified":true,"entityCountMatches":true,"operationCount":46,"expectedEntityCount":46,"entitiesAdded":46,"operationSetId":"verified-operation-set"}',
    }])).toBe(true);
    expect(buildActionContract(text).preferredTools).toContain('cad_prepare_autocad_operations');
    expect(buildActionContract(text).preferredTools).toContain('mcp_cad-drafting_autocad_playback_file');
    expect(buildActionContract(text).preferredTools).not.toContain('cad_generate_dxf');
  });

  it('does not accept a folder inventory or default grid as source-grounded CAD', () => {
    const text = 'Based on the attached floor plan image, create an editable CAD DXF file.';
    const contract = buildActionContract(text);
    const inventoryOnly = [{
      id: 'inventory',
      name: 'mcp_cad-drafting_cad_renovation_folder_workflow',
      arguments: { folderPath: 'C:\\source' },
      result: '{"workflowState":"awaiting_image_geometry_extraction","cadFiles":[]}',
    }, {
      id: 'verify-inventory',
      name: 'work_product_verify',
      arguments: {},
      result: '{"status":"pass"}',
    }];
    const grounded = [{
      id: 'geometry',
      name: 'floorplan_extract_geometry',
      arguments: { imagePath: 'C:\\source\\plan.png', knownDimensions: '9000 x 7600 mm' },
      result: '{"geometryReady":true,"geometryVerified":true,"geometryReceiptPath":"C:\\\\source\\\\plan.geometry-receipt.json","cadGenerateDxfArgs":{"width":9000,"height":7600,"sourcePath":"C:\\\\source\\\\plan.png","walls":[{"x1":0,"y1":0,"x2":9000,"y2":0}],"rooms":[{"name":"Living","x":0,"y":0,"width":4500,"height":3800}]}}',
    }, {
      id: 'dxf',
      name: 'cad_generate_dxf',
      arguments: { sourcePath: 'C:\\source\\plan.png', width: 9000, height: 7600, walls: [{ x1: 0, y1: 0, x2: 9000, y2: 0 }] },
      result: '{"path":"C:\\\\output\\\\plan.dxf","bytes":2400,"geometryVerified":true,"geometryValidation":{"passed":true},"geometryReceiptPath":"C:\\\\source\\\\plan.geometry-receipt.json"}',
    }, {
      id: 'verify-dxf',
      name: 'work_product_verify',
      arguments: {},
      result: '{"status":"pass","artifactChecks":[{"path":"C:\\\\output\\\\plan.dxf","exists":true}]}',
    }];

    expect(contract.kind).toBe('cad_drafting');
    expect(hasCoreActionEvidence(contract, inventoryOnly, text)).toBe(false);
    expect(hasCoreActionEvidence(contract, grounded, text)).toBe(true);
  });

  it('requires MCP marker evidence and excludes script fallback for an explicit MCP-only run', () => {
    const text = 'Draw this visibly in AutoCAD stroke by stroke. Use AutoCAD MCP only; do not use LISP, scripts, or fallback.';
    const fallback = [{
      id: 'fallback',
      name: 'cad_generate_dxf',
      arguments: {},
      result: '{"status":"completed","completionMarkerExists":true}',
    }];
    const mcp = [{
      id: 'mcp',
      name: 'mcp_cad-drafting_autocad_playback_file',
      arguments: {},
      result: '{"status":"completed","transport":"mcp_autocad_com","visiblePlayback":true,"completionMarkerExists":true,"geometryVerified":true,"entityCountMatches":true,"operationCount":46,"expectedEntityCount":46,"entitiesAdded":46,"operationSetId":"verified-operation-set"}',
    }];

    expect(requiresAutoCadMcpPlayback(text)).toBe(true);
    expect(buildActionContract(text).preferredTools).toContain('cad_prepare_autocad_operations');
    expect(buildActionContract(text).preferredTools).not.toContain('cad_generate_dxf');
    expect(hasVisibleAutoCadExecutionEvidence(fallback, text)).toBe(false);
    expect(hasVisibleAutoCadExecutionEvidence(mcp, text)).toBe(true);
  });

  it('keeps CAD primary when a browser preview is explicitly rejected', () => {
    const contract = buildActionContract(
      'Draw this in AutoCAD. Do not use a browser preview or DXF-only delivery.',
    );

    expect(contract.kind).toBe('cad_drafting');
  });

  it('treats AutoCAD installation inspection as desktop observation', () => {
    const contract = buildActionContract(
      'Inspect the installed AutoCAD launch target and do not open anything.',
    );

    expect(contract.kind).toBe('desktop_operation');
  });

  it('requires authenticated result evidence for login-then-search browser work', () => {
    const text = '\u6253\u5f00\u4e2d\u56fd\u88c1\u5224\u6587\u4e66\u7f51\uff0c\u81ea\u52a8\u767b\u5f55\u8d26\u53f7\u627e\u4e00\u4e0b\u6d59\u6c5f\u7701\u7684\u6848\u4ef6';

    expect(buildActionContract(text).kind).toBe('browser_account');
    expect(requiresAuthenticatedWebResult(text)).toBe(true);
    expect(buildActionContract(text).preferredTools.slice(0, 4)).toEqual([
      'web_login_profile_list',
      'web_login_profile_save_from_preset',
      'web_login_run',
      'url_fetch_logged_in',
    ]);
    expect(hasAuthenticatedWebResultEvidence([{
      id: 'login-page',
      name: 'mcp_playwright_browser_snapshot',
      arguments: {},
      result: 'Page URL: https://wenshu.court.gov.cn/website/wenshu/181010CARHS5BS3C/index.html?open=login\\n登录/注册',
    }], text)).toBe(false);
    expect(hasAuthenticatedWebResultEvidence([{
      id: 'result-page',
      name: 'mcp_playwright_browser_snapshot',
      arguments: {},
      result: 'Page URL: https://wenshu.court.gov.cn/search\\n浙江省 案件 检索结果 列表 裁判文书',
    }], text)).toBe(true);
  });

  it('renders a reusable prompt section with stages and evidence', () => {
    const prompt = formatActionContractPrompt(buildActionContract('\u89c6\u9891\u7f51\u7ad9\u81ea\u52a8\u8bc4\u8bba'));

    expect(prompt).toContain('Lumi Action Contract');
    expect(prompt).toContain('Core action');
    expect(prompt).toContain('Preparation is not completion');
    expect(prompt).toContain('Required completion evidence');
  });
});
