from pathlib import Path
p=Path('js/binary/pe-loader.js')
s=p.read_text()
s=s.replace("reached its mapped file boundary/budget without a NUL terminator", "reached its mapped file boundary without a NUL terminator")
s=s.replace("reached its mapped boundary/budget without a zero terminator", "reached its mapped boundary without a zero terminator")
s=s.replace("reached its mapped boundary/budget", "reached its mapped boundary")
p.write_text(s)
