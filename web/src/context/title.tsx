import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";

const TitleContext = createContext<{
  title: string;
  setTitle: (t: string) => void;
}>({ title: "", setTitle: () => {} });

export function TitleProvider({ children }: { children: React.ReactNode }) {
  const [title, setTitle] = useState("");
  return (
    <TitleContext.Provider value={{ title, setTitle }}>
      {children}
    </TitleContext.Provider>
  );
}

export function usePageTitle(title: string) {
  const { setTitle } = useContext(TitleContext);
  useEffect(() => {
    setTitle(title);
    return () => { setTitle(""); };
  }, [setTitle, title]);
}

export function useCurrentTitle() {
  return useContext(TitleContext).title;
}
