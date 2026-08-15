from pathlib import Path
p=Path('js/binary/pe-loader.js')
s=p.read_text()
s=s.replace("function markPEPartial(image, reason, warning = null) {\n  image.metadata.peMetadata ||=", "function markPEPartial(image, reason, warning = null) {\n  image.metadata ||= {};\n  image.metadata.peMetadata ||=")
s=s.replace("export function createPEMetadataBudget(image, options = {}) {\n  const limits", "export function createPEMetadataBudget(image, options = {}) {\n  image.metadata ||= {};\n  const limits")
s=s.replace("reached its mapped file boundary/budget without a NUL terminator", "reached its mapped file boundary without a NUL terminator")
s=s.replace("reached its mapped boundary/budget without a zero terminator", "reached its mapped boundary without a zero terminator")
s=s.replace("reached its mapped boundary/budget", "reached its mapped boundary")
p.write_text(s)
