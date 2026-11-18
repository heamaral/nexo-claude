package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const maxBinary = int64(200 << 20)
const maxArchive = int64(100 << 20)

// Only two regular files can be materialized, at fixed destination names.
// Archive paths are validated even for ignored entries; no archive-provided
// path, permission, link or executable is ever used as an output path.
func extractRuntime(archive, stage string, a Artifact) error {
	seen := map[string]bool{}
	copyEntry := func(name string, size int64, regular bool, open func() (io.ReadCloser, error)) error {
		if strings.ContainsAny(name, "\\:\x00") || path.IsAbs(name) || path.Clean(name) != strings.TrimSuffix(name, "/") || !strings.HasPrefix(name, a.Root+"/") {
			return fmt.Errorf("unsafe runtime archive path")
		}
		rel := strings.TrimPrefix(name, a.Root+"/")
		output, limit := "", maxBinary
		switch rel {
		case a.Binary:
			output = "node"
			if strings.HasSuffix(a.Binary, ".exe") {
				output += ".exe"
			}
		case "LICENSE":
			output = "LICENSE"
			limit = 10 << 20
		default:
			return nil
		}
		if !regular || size < 1 || size > limit || seen[output] {
			return fmt.Errorf("invalid or duplicate runtime archive entry")
		}
		seen[output] = true
		input, err := open()
		if err != nil {
			return err
		}
		defer input.Close()
		f, err := os.OpenFile(filepath.Join(stage, output), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if err != nil {
			return err
		}
		n, copyErr := io.Copy(f, io.LimitReader(input, limit+1))
		if copyErr == nil && n != size {
			copyErr = fmt.Errorf("truncated or oversized runtime entry")
		}
		if copyErr == nil {
			copyErr = f.Sync()
		}
		closeErr := f.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	}
	if strings.HasSuffix(a.URL, ".zip") {
		z, err := zip.OpenReader(archive)
		if err != nil {
			return err
		}
		defer z.Close()
		if len(z.File) > 100000 {
			return fmt.Errorf("too many runtime archive entries")
		}
		for _, f := range z.File {
			if f.FileInfo().IsDir() {
				continue
			}
			err = copyEntry(f.Name, int64(f.UncompressedSize64), f.Mode().IsRegular(), f.Open)
			if err != nil {
				return err
			}
		}
	} else {
		f, err := os.Open(archive)
		if err != nil {
			return err
		}
		defer f.Close()
		g, err := gzip.NewReader(f)
		if err != nil {
			return err
		}
		defer g.Close()
		t := tar.NewReader(g)
		var total int64
		count := 0
		for {
			h, err := t.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			count++
			total += h.Size
			if count > 100000 || total > 512<<20 {
				return fmt.Errorf("runtime archive exceeds extraction limits")
			}
			if h.Typeflag == tar.TypeDir {
				continue
			}
			err = copyEntry(h.Name, h.Size, h.Typeflag == tar.TypeReg, func() (io.ReadCloser, error) { return io.NopCloser(t), nil })
			if err != nil {
				return err
			}
		}
	}
	if !seen["LICENSE"] || !(seen["node"] || seen["node.exe"]) {
		return fmt.Errorf("runtime archive is missing Node or its license")
	}
	return nil
}
