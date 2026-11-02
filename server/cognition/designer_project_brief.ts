import { isDesignProjectCreationRequest } from '../regions/routing/industry_profile';
import { affirmativeDesignerInstructionText } from './designer_clause_projection';

// Pure explicit-brief extraction retained from Designer; it never dispatches a tool.
function captureChineseField(text: string, pattern: RegExp): string {
  return String(text.match(pattern)?.[1] || '').replace(/^[“”"'\s]+|[“”"'\s]+$/g, '').trim();
}

export function parseDeterministicDesignProjectCreateArguments(text: string): Record<string, string> | null {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!isDesignProjectCreationRequest(affirmativeDesignerInstructionText(clean))) return null;
  const name = captureChineseField(clean, /(?:\u540d\u79f0|\u9879\u76ee\u540d(?:\u79f0)?)(?:\u4e3a|\u662f|\u53eb|[:\uff1a=])?\s*[“"']?([^”"'\uff0c\u3002\uff1b;]{2,80})/u)
    || captureChineseField(clean, /(?:\u5ba4\u5185|\u88c5\u4fee|\u8bbe\u8ba1)?\u9879\u76ee\s*[\u201c\u201d"']([^\u201c\u201d"'\uff0c\u3002\uff1b;]{2,80})[\u201c\u201d"']/u);
  if (!name) return null;
  const projectType = /(?:\u4f4f\u5b85|\u5bb6\u88c5)/u.test(clean)
    ? 'residential'
    : /(?:\u529e\u516c|\u5199\u5b57\u697c)/u.test(clean)
      ? 'office'
      : /(?:\u96f6\u552e|\u5546\u4e1a|\u5e97\u94fa)/u.test(clean)
        ? 'retail'
        : /(?:\u9152\u5e97|\u6c11\u5bbf|\u9910\u996e)/u.test(clean)
          ? 'hospitality'
          : 'other';
  const location = captureChineseField(clean, /(?:\u5730\u70b9|\u4f4d\u7f6e|\u9879\u76ee\u5730\u5740)(?:\u4e3a|\u662f|[:\uff1a=])?\s*([^\uff0c\u3002\uff1b;]{2,80})/u);
  const area = captureChineseField(clean, /(?:\u5efa\u7b51\u9762\u79ef|\u5957\u5185\u9762\u79ef|\u9762\u79ef)(?:\u4e3a|\u662f|[:\uff1a=])?\s*([0-9.]+\s*(?:\u5e73\u65b9\u7c73|\u5e73\u7c73|\u33a1))/u);
  const occupants = captureChineseField(clean, /(?:\u5c45\u4f4f\u8005|\u4f7f\u7528\u8005|\u5bb6\u5ead\u6210\u5458)(?:\u4e3a|\u662f|[:\uff1a=])?\s*([^\uff0c\u3002\uff1b;]{2,120})/u);
  const budget = captureChineseField(clean, /(?:[^\uff0c\u3002\uff1b;]{0,16})?\u9884\u7b97(?:\u4e3a|\u662f|[:\uff1a=])?\s*([0-9.]+\s*(?:\u4e07\u5143|\u5143|CNY|RMB))/iu);
  const style = captureChineseField(clean, /(?:\u504f\u597d|\u98ce\u683c)(?:\u4e3a|\u662f|[:\uff1a=])?\s*([^\uff0c\u3002\uff1b;]{2,80})/u)
    || captureChineseField(clean, /\u559c\u6b22\s*([^\uff0c\u3002\uff1b;]{2,80})/u);
  const requirements = captureChineseField(clean, /\u9700\u6c42\s*[:\uff1a=]\s*([\s\S]*?)(?=[\uff1b;]\s*\u7ea6\u675f\s*[:\uff1a=]|\u3002\s*\u8bf7|$)/u);
  const constraints = captureChineseField(clean, /\u7ea6\u675f\s*[:\uff1a=]\s*([\s\S]*?)(?=\u3002(?:\s*\u8bf7|$)|$)/u);
  const args: Record<string, string> = { name, projectType };
  for (const [key, value] of Object.entries({ location, area, occupants, budget, style, requirements, constraints })) {
    if (value) args[key] = value;
  }
  return args;
}

export function isDesignProjectCreateAndSchemeRequest(text: string): boolean {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!isDesignProjectCreationRequest(clean)) return false;
  return /(?:\u751f\u6210|\u5f62\u6210|\u5236\u4f5c|\u8f93\u51fa|\u5f52\u6863|generate|create|build|produce).{0,36}(?:\u9879\u76ee\u65b9\u6848|\u8bbe\u8ba1\u65b9\u6848|project\s+scheme)/iu.test(clean);
}
