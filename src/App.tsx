import { useState } from 'react';

export const App = () => {
  const [count, setCount] = useState(999);

  return (
    <div>
      <h1>Count: {count}</h1>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  );
};

export default App;
