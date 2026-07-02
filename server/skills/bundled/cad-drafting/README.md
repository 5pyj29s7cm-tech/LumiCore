# CAD Drafting Pack

This bundled skill supports renovation and CAD/BIM handoff work.

## Learned Delivery Standard

When Lumi takes over a renovation/design delivery task, the output should feel like work a client can review, not a system demo:

- Treat video workflows as reference patterns, not fixed scripts: infer the current project goal, choose the required deliverables, use the external tools available on the computer, and verify visible results before reporting completion.
- Generate a desktop delivery package with proposal notes, budget/material list, PPTX, PDF, CAD DXF, CAD preview, Dynamo/Revit handoff script, room schedule, and messaging draft.
- Make PPT/PDF content about the actual design: layout decisions, room strategy, material palette, budget allocation, and next-step risks. Do not fill the deck with Lumi capability narration.
- Open real external tools where available. For CAD, prefer the user's desktop CAD app such as FreeCAD, AutoCAD-compatible tools, ZWCAD, GstarCAD, or LibreCAD. A browser/SVG preview is only a fallback.
- For Revit/BIM, produce Dynamo scripts and room schedules as handoff data. Do not claim native RVT production unless a confirmed Revit adapter is present.
- For messaging handoff, restore an already-running personal WeChat/Weixin window before launching shortcuts; enterprise WeChat/WeCom is a fallback.
- Keep sending disabled by default unless the user explicitly authorizes it.

## Tools

- `cad_space_program`: create a room/space program with assumptions.
- `cad_generate_simple_dxf`: generate an editable conceptual DXF.
- `cad_drafting_checklist`: produce a drawing QA checklist.
- `cad_renovation_folder_workflow`: scan a renovation folder and generate drafting bases, proposal notes, material lists, and handoff files.

Production CAD/Revit outputs still require site dimensions, structural/MEP review, local standards, and qualified professional verification.
