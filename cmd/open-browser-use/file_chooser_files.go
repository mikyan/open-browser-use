package main

import (
	"errors"
	"io"

	"github.com/spf13/cobra"
)

type fileChooserSelection struct {
	id    string
	files []string
	clear bool
}

func (selection *fileChooserSelection) addFlags(command *cobra.Command) {
	command.Flags().StringVar(&selection.id, "file-chooser-id", "", "file chooser id returned by wait-file-chooser")
	command.Flags().StringSliceVar(&selection.files, "file", nil, "file path to set; repeat or comma-separate for multiple files")
	command.Flags().BoolVar(&selection.clear, "clear", false, "clear the intercepted file input; cannot be combined with files")
}

func (selection fileChooserSelection) params(fileFlagPresent bool) (map[string]any, error) {
	if selection.clear {
		// An explicit empty --file= is still a conflicting selection request.
		if fileFlagPresent || len(selection.files) != 0 {
			return nil, errors.New("set-file-chooser-files --clear cannot be combined with files")
		}
		selection.files = []string{}
	} else if len(selection.files) == 0 {
		return nil, errors.New("set-file-chooser-files requires files or explicit --clear")
	}
	return fileChooserFilesParams(selection.id, selection.files)
}

func fileChooserFilesParams(id string, files []string) (map[string]any, error) {
	if id == "" {
		return nil, errors.New("set-file-chooser-files requires file chooser id")
	}
	if files == nil {
		return nil, errors.New("set-file-chooser-files requires an explicit files array")
	}
	for _, file := range files {
		if file == "" {
			return nil, errors.New("set-file-chooser-files requires non-empty file paths")
		}
	}
	// Keep empty selection as JSON [], never null. This is also the typed MCP
	// boundary: IDs and paths are data, not another command-line parse.
	return map[string]any{"fileChooserId": id, "files": append([]string{}, files...)}, nil
}

func buildSetFileChooserFilesCommand(args []string) (map[string]any, error) {
	var selection fileChooserSelection
	command := &cobra.Command{Use: "set-file-chooser-files"}
	command.SetOut(io.Discard)
	command.SetErr(io.Discard)
	selection.addFlags(command)
	if err := command.ParseFlags(args); err != nil {
		return nil, err
	}
	positional := command.Flags().Args()
	if !command.Flags().Changed("file-chooser-id") && len(positional) > 0 {
		selection.id, positional = positional[0], positional[1:]
	}
	if command.Flags().Changed("file") && len(positional) > 0 {
		return nil, errors.New("set-file-chooser-files cannot combine positional files with --file")
	}
	selection.files = append(selection.files, positional...)
	return selection.params(command.Flags().Changed("file"))
}
