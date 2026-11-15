"""Marks backlog tasks done: python scripts/backlog-done.py T-068 T-069

The backlog table's padding changes as Prettier reflows it, so match the row
by its ID and replace only the last status cell.
"""
import re
import sys

PATH = "docs/backlog.md"
text = open(PATH, encoding="utf-8").read()
for task in sys.argv[1:]:
    pattern = re.compile(rf"^(\| {re.escape(task)} \|.*\|\s*)todo(\s*\|)\s*$", re.M)
    text, count = pattern.subn(r"\1done\2", text)
    print(f"{task}: {'done' if count else 'not found or already done'}")
open(PATH, "w", encoding="utf-8").write(text)
