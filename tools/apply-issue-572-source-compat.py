from pathlib import Path
p=Path('js/binary/macho.js')
s=p.read_text()
old="""    catch (e) {
      status.complete = false; status.partialReason = 'truncated-leb';
      image.warnings.push(`LC_FUNCTION_STARTS: ${e.message}`); break;
    }"""
new="""    catch (e) {
      if (e?.code === 'BINARY_SOURCE_RANGE_MISSING') throw e;
      status.complete = false; status.partialReason = 'truncated-leb';
      image.warnings.push(`LC_FUNCTION_STARTS: ${e.message}`); break;
    }"""
if old not in s: raise SystemExit('LC_FUNCTION_STARTS catch anchor missing')
p.write_text(s.replace(old,new,1))
