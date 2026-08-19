import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.symbol.Reference;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class GhidraRealBinaryProbe extends GhidraScript {
    private static final Pattern GOTO = Pattern.compile("\\bgoto\\b");
    private static final Pattern CAST = Pattern.compile("\\([^()\\n]*(?:int|char|long|short|void|float|double|uint|size_t)[^()\\n]*\\)");
    private static final Pattern TEMP = Pattern.compile("\\b(?:local_|uVar|iVar|lVar|pcVar|puVar|tmp|v)\\w*");

    private static int count(Pattern p, String s) {
        int n = 0;
        Matcher m = p.matcher(s == null ? "" : s);
        while (m.find()) n++;
        return n;
    }

    private static String hex(Address a) {
        return Long.toUnsignedString(a.getOffset(), 16);
    }

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 2) throw new IllegalArgumentException("expected <sample-addresses.txt> <output.txt>");
        Path samplePath = Path.of(args[0]);
        Path outPath = Path.of(args[1]);

        DecompInterface decompiler = new DecompInterface();
        decompiler.toggleCCode(true);
        decompiler.toggleSyntaxTree(true);
        if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException("Ghidra decompiler openProgram failed");

        try (BufferedWriter out = Files.newBufferedWriter(outPath, StandardCharsets.UTF_8)) {
            FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
            while (functions.hasNext() && !monitor.isCancelled()) {
                Function fn = functions.next();
                out.write("F " + hex(fn.getEntryPoint()));
                out.newLine();
            }

            Set<String> calls = new HashSet<>();
            InstructionIterator insns = currentProgram.getListing().getInstructions(true);
            while (insns.hasNext() && !monitor.isCancelled()) {
                Instruction insn = insns.next();
                for (Reference ref : insn.getReferencesFrom()) {
                    if (!ref.getReferenceType().isCall()) continue;
                    Address to = ref.getToAddress();
                    if (to == null || !to.isMemoryAddress()) continue;
                    String row = "C " + hex(insn.getAddress()) + " " + hex(to);
                    if (calls.add(row)) {
                        out.write(row);
                        out.newLine();
                    }
                }
            }

            try (BufferedReader samples = Files.newBufferedReader(samplePath, StandardCharsets.UTF_8)) {
                String line;
                while ((line = samples.readLine()) != null && !monitor.isCancelled()) {
                    line = line.trim();
                    if (line.isEmpty()) continue;
                    Address addr = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(line);
                    Function fn = currentProgram.getFunctionManager().getFunctionAt(addr);
                    if (fn == null) {
                        out.write("D " + line + " miss 0 0 0 0");
                        out.newLine();
                        continue;
                    }
                    DecompileResults result = decompiler.decompileFunction(fn, 15, monitor);
                    if (!result.decompileCompleted() || result.getDecompiledFunction() == null) {
                        out.write("D " + line + " fail 0 0 0 0");
                        out.newLine();
                        continue;
                    }
                    String c = result.getDecompiledFunction().getC();
                    int lines = c.isEmpty() ? 0 : c.split("\\R", -1).length;
                    out.write("D " + line + " ok " + lines + " " + count(GOTO, c) + " " + count(CAST, c) + " " + count(TEMP, c));
                    out.newLine();
                }
            }
        } finally {
            decompiler.dispose();
        }
    }
}
