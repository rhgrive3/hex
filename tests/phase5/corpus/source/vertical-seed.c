// Frozen Phase 5 vertical seed. See ../manifest.json for exact provenance.
int p5_vertical_seed(int *pointer, unsigned char input) {
  int value = *pointer;
  value += (int)input;
  if (value > 7)
    *pointer = value;
  else
    *pointer = value - 1;
  return *pointer;
}
