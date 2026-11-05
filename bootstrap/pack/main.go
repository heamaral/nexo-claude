// Build-time only: canonical gzip streams produced by the pinned Go toolchain.
package main

import (
	"compress/gzip"
	"fmt"
	"io"
	"os"
)

func main() {
	if err := pack(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func pack() error {
	if len(os.Args) != 3 {
		return fmt.Errorf("usage: pack <source> <target>")
	}
	in, err := os.Open(os.Args[1])
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(os.Args[2])
	if err != nil {
		return err
	}
	defer out.Close()
	z, err := gzip.NewWriterLevel(out, gzip.BestCompression)
	if err != nil {
		return err
	}
	if _, err = io.Copy(z, in); err != nil {
		return err
	}
	if err = z.Close(); err != nil {
		return err
	}
	return out.Sync()
}
