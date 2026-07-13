# CAD Drafting Pack

This bundled skill supports renovation and CAD/BIM handoff work.

## Execution Standard

When Lumi takes over a renovation/design delivery task, the output should feel like work a client can review, not a system demo:

- Read the supplied project files first and derive geometry, constraints, rooms, dimensions, and requested outputs from those sources. Missing dimensions remain explicit blockers rather than being replaced with a default floor plan.
- Produce only the deliverables requested for the current project. Each CAD, BIM, presentation, render, budget, and messaging result keeps its own tool evidence and verification state.
- Make PPT/PDF content about the actual design and verified source material. Do not fill the deck with Lumi capability narration or a fixed demo project.
- Treat DXF/DWG generation as an explicit file deliverable only. It never proves that visible AutoCAD drawing completed.
- For visible AutoCAD work, prepare validated entity operations and use the AutoCAD MCP/COM playback tool. Do not fall back to LISP, SCRIPT, batch commands, cursor drawing, a browser/SVG preview, or a finished file when playback fails.
- For Revit/BIM, use a confirmed adapter and verify the native model or IFC output. A Dynamo script, room schedule, or handoff note does not prove native BIM production.
- For messaging handoff, restore an already-running personal WeChat/Weixin window before launching shortcuts; enterprise WeChat/WeCom is a fallback.
- Keep sending disabled by default unless the user explicitly authorizes it.

## Tools

- `cad_space_program`: create a room/space program with assumptions.
- `cad_drafting_checklist`: produce a drawing QA checklist.
- `cad_renovation_folder_workflow`: inventory a renovation folder and extract source facts without generating a default floor plan or delivery package.
- `autocad_playback_file`: visibly draw validated operations in the real Windows AutoCAD application and emit a completion marker only after every operation finishes.

Production CAD/Revit outputs still require site dimensions, structural/MEP review, local standards, and qualified professional verification.
