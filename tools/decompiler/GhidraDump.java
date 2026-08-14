// Headless GhidraScript used only for optional differential benchmarking.
// Ghidra is not the oracle: compiler source/semantic manifests remain ground truth.
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;

public class GhidraDump extends GhidraScript {
    @Override
    protected void run() throws Exception {
        DecompInterface decompiler = new DecompInterface();
        try {
            decompiler.toggleCCode(true);
            decompiler.toggleSyntaxTree(true);
            if (!decompiler.openProgram(currentProgram)) {
                println("GHIDRA_ERROR openProgram");
                return;
            }
            FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
            while (functions.hasNext() && !monitor.isCancelled()) {
                Function fn = functions.next();
                DecompileResults result = decompiler.decompileFunction(fn, 30, monitor);
                if (!result.decompileCompleted() || result.getDecompiledFunction() == null) continue;
                String c = result.getDecompiledFunction().getC();
                c = c.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "");
                println("GHIDRA_FUNCTION " + fn.getName() + " " + c);
            }
        } finally {
            decompiler.dispose();
        }
    }
}
