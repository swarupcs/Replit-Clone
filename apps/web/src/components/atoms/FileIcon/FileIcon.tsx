import type { CSSProperties, ReactNode } from "react";
import { FaCss3, FaHtml5, FaJs } from "react-icons/fa";
import { GrReactjs } from "react-icons/gr";

const iconStyle: CSSProperties = {
  height: "20px",
  width: "20px",
};

const iconMapper: Record<string, ReactNode> = {
  js: <FaJs color="yellow" style={iconStyle} />,
  jsx: <GrReactjs color="#61dbfa" style={iconStyle} />,
  css: <FaCss3 color="#3c99dc" style={iconStyle} />,
  html: <FaHtml5 color="#e34c26" style={iconStyle} />,
};

interface FileIconProps {
  extension: string | undefined;
}

export const FileIcon = ({ extension }: FileIconProps) => {
  return <>{extension ? iconMapper[extension] : null}</>;
};
