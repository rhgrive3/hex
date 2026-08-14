from pathlib import Path
p=Path('js/blocks.js');t=p.read_text()
old="""    } catch (error) {
      diagnostics.push({ severity:'error', stage:'instruction', row:r.row, address:r.address ?? null, message:error?.message || String(error), text:`${r.mn || ''} ${r.ops || ''}`.trim() });
      insns.push({
        row:r.row, address:r.address, mnemonic:r.mn || '', operands:r.ops || '', ops:[], data:false,
        category:'unknown', reads:[], writes:[], role:'other', unknown:true,
        analysisError:{ stage:'instruction', message:error?.message || String(error) },
      });
    }
"""
new="""    } catch (error) {
      let row = -1, address = null, mnemonic = '', operands = '';
      try { row = r?.row ?? -1; } catch { /* hostile input getter */ }
      try { address = r?.address ?? null; } catch { /* hostile input getter */ }
      try { mnemonic = r?.mn || ''; } catch { /* hostile input getter */ }
      try { operands = r?.ops || ''; } catch { /* hostile input getter */ }
      const message = error?.message || String(error);
      diagnostics.push({ severity:'error', stage:'instruction', row, address, message, text:`${mnemonic} ${operands}`.trim() });
      insns.push({
        row, address, mnemonic, operands, ops:[], data:false,
        category:'unknown', reads:[], writes:[], role:'other', unknown:true,
        analysisError:{ stage:'instruction', message },
      });
    }
"""
if t.count(old)!=1: raise SystemExit('postfix catch block mismatch')
p.write_text(t.replace(old,new))
